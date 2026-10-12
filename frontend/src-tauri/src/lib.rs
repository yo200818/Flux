use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, State};

use serde::Deserialize;

mod application_picker;
mod companion_lifecycle;
mod configuration_export;
mod shortcut_capture;
mod usb_transport;
mod windows_process;

const BACKEND_PORT: u16 = 8000;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_millis(250);
const USB_MONITOR_INTERVAL: Duration = Duration::from_secs(1);
#[cfg(windows)]
const WIFI_ENABLE_ENV: &str = "POCKETDECK_ENABLE_WIFI";

#[cfg(windows)]
struct CompanionInstanceLock {
    _lock_file: File,
}

#[cfg(windows)]
fn try_acquire_companion_lock(lock_path: &Path) -> Result<Option<File>, String> {
    let lock_file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|error| format!("Could not create companion lock file: {error}"))?;

    match lock_file.try_lock() {
        Ok(()) => Ok(Some(lock_file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => {
            Err(format!("Could not lock companion lock file: {error}"))
        }
    }
}

#[cfg(windows)]
impl CompanionInstanceLock {
    fn acquire() -> Result<Option<Self>, String> {
        let data_dir = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));
        let lock_dir = data_dir.join("PocketDeck");
        fs::create_dir_all(&lock_dir)
            .map_err(|error| format!("Could not create PocketDeck data directory: {error}"))?;
        let lock_file = lock_dir.join(".companion_lock");

        try_acquire_companion_lock(&lock_file)
            .map(|lock_file| lock_file.map(|_lock_file| Self { _lock_file }))
    }
}

#[cfg(not(windows))]
struct CompanionInstanceLock;

#[cfg(not(windows))]
impl CompanionInstanceLock {
    fn acquire() -> Result<Option<Self>, String> {
        Ok(Some(Self))
    }
}

#[derive(Default)]
struct BackendRuntime {
    child: Mutex<Option<Child>>,
    startup_error: Mutex<Option<String>>,
    log_path: Mutex<Option<PathBuf>>,
    admin_token: Mutex<Option<String>>,
    usb_monitor: Mutex<Option<UsbReverseMonitor>>,
}

struct UsbReverseMonitor {
    stop: Arc<AtomicBool>,
    thread: thread::JoinHandle<()>,
}

impl BackendRuntime {
    fn start(&self, app: &tauri::AppHandle) {
        match start_backend(app) {
            Ok((child, log_path, admin_token)) => {
                *self.log_path.lock().expect("backend log mutex poisoned") = Some(log_path);
                *self.child.lock().expect("backend process mutex poisoned") = Some(child);
                *self
                    .admin_token
                    .lock()
                    .expect("backend admin token mutex poisoned") = Some(admin_token.clone());
                self.start_usb_reverse_monitor(admin_token);
            }
            Err((message, log_path)) => {
                let startup_error = format_startup_error(&message, log_path.as_deref());
                *self.log_path.lock().expect("backend log mutex poisoned") = log_path;
                *self
                    .startup_error
                    .lock()
                    .expect("backend startup mutex poisoned") = Some(startup_error);
            }
        }
    }

    #[cfg(windows)]
    fn start_usb_reverse_monitor(&self, admin_token: String) {
        let log_path = self
            .log_path
            .lock()
            .expect("backend log mutex poisoned")
            .clone();
        let Some(log_path) = log_path else {
            return;
        };
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let monitor_thread =
            thread::spawn(move || run_usb_reverse_monitor(thread_stop, admin_token, log_path));
        *self.usb_monitor.lock().expect("USB monitor mutex poisoned") = Some(UsbReverseMonitor {
            stop,
            thread: monitor_thread,
        });
    }

    #[cfg(not(windows))]
    fn start_usb_reverse_monitor(&self, _admin_token: String) {}

    fn stop(&self) {
        if let Some(monitor) = self
            .usb_monitor
            .lock()
            .expect("USB monitor mutex poisoned")
            .take()
        {
            monitor.stop.store(true, Ordering::Relaxed);
            if monitor.thread.join().is_err() {
                self.log_shutdown_error("The USB reverse monitor stopped unexpectedly.");
            }
        }
        let Some(mut child) = self
            .child
            .lock()
            .expect("backend process mutex poisoned")
            .take()
        else {
            return;
        };

        let already_exited = matches!(child.try_wait(), Ok(Some(_)));
        if !already_exited {
            if let Err(error) = child.kill() {
                self.log_shutdown_error(&format!(
                    "Could not stop owned backend process {}: {error}",
                    child.id()
                ));
            }
            if let Err(error) = child.wait() {
                self.log_shutdown_error(&format!(
                    "Could not wait for owned backend process {} to exit: {error}",
                    child.id()
                ));
            }
        }
    }

    fn log_shutdown_error(&self, message: &str) {
        let log_path = self
            .log_path
            .lock()
            .expect("backend log mutex poisoned")
            .clone();
        if let Some(log_path) = log_path {
            if let Ok(mut log) = OpenOptions::new().append(true).open(log_path) {
                let _ = writeln!(log, "{message}");
            }
        }
    }
}

impl Drop for BackendRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

fn start_backend(
    app: &tauri::AppHandle,
) -> Result<(Child, PathBuf, String), (String, Option<PathBuf>)> {
    let admin_token = generate_admin_token().map_err(|error| (error, None))?;
    let executable = app
        .path()
        .resolve(
            "pocketdeck-backend/pocketdeck-backend.exe",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|error| {
            (
                format!("Could not locate the bundled backend executable: {error}"),
                None,
            )
        })?;
    let log_path = app
        .path()
        .app_local_data_dir()
        .map_err(|error| {
            (
                format!("Could not locate PocketDeck's local data directory: {error}"),
                None,
            )
        })?
        .join("logs")
        .join("backend.log");
    fs::create_dir_all(log_path.parent().expect("backend log path has a parent")).map_err(
        |error| {
            (
                format!(
                    "Could not create the backend log directory '{}': {error}",
                    log_path.display()
                ),
                Some(log_path.clone()),
            )
        },
    )?;
    let log = File::create(&log_path).map_err(|error| {
        (
            format!(
                "Could not create the backend log file '{}': {error}",
                log_path.display()
            ),
            Some(log_path.clone()),
        )
    })?;
    let data_directory = app.path().app_local_data_dir().map_err(|error| {
        (
            format!("Could not locate PocketDeck's local data directory: {error}"),
            Some(log_path.clone()),
        )
    })?;
    fs::create_dir_all(&data_directory).map_err(|error| {
        (
            format!("Could not create PocketDeck's local data directory: {error}"),
            Some(log_path.clone()),
        )
    })?;
    let stderr = log.try_clone().map_err(|error| {
        (
            format!("Could not prepare backend logging: {error}"),
            Some(log_path.clone()),
        )
    })?;
    let mut command = Command::new(&executable);
    configure_backend_command(&mut command, &admin_token, &data_directory);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));
    let mut child = command.spawn().map_err(|error| {
        (
            format!(
                "Could not launch the bundled backend '{}': {error}",
                executable.display()
            ),
            Some(log_path.clone()),
        )
    })?;

    if let Err(error) = wait_for_backend(&mut child) {
        stop_child(&mut child, &log_path);
        return Err((
            format_startup_error(&error, Some(&log_path)),
            Some(log_path),
        ));
    }
    Ok((child, log_path, admin_token))
}

fn configure_backend_command(
    command: &mut Command,
    admin_token: &str,
    data_directory: &Path,
) -> u32 {
    command
        .env("POCKETDECK_ADMIN_TOKEN", admin_token)
        .env("POCKETDECK_WIFI_DATA_DIR", data_directory);
    let window_flags = windows_process::hide_console_window(command);
    #[cfg(windows)]
    command.env(WIFI_ENABLE_ENV, "1");
    window_flags
}

fn generate_admin_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    #[cfg(windows)]
    {
        use std::ffi::c_void;

        #[link(name = "bcrypt")]
        unsafe extern "system" {
            fn BCryptGenRandom(
                algorithm: *mut c_void,
                buffer: *mut u8,
                length: u32,
                flags: u32,
            ) -> i32;
        }

        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                2,
            )
        };
        if status < 0 {
            return Err(format!(
                "Windows could not generate a backend authentication secret (status {status})."
            ));
        }
    }
    #[cfg(not(windows))]
    {
        File::open("/dev/urandom")
            .and_then(|mut random| random.read_exact(&mut bytes))
            .map_err(|error| {
                format!("Could not generate backend authentication secret: {error}")
            })?;
    }
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut token, "{byte:02x}")
            .map_err(|error| format!("Could not format backend authentication secret: {error}"))?;
    }
    Ok(token)
}
fn wait_for_backend(child: &mut Child) -> Result<(), String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, BACKEND_PORT));
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not check backend process status: {error}"))?
        {
            return Err(format!(
                "The backend process exited during startup with status {status}."
            ));
        }

        if let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let request = format!(
                "GET /api/health HTTP/1.1\r\n\
                     Host: 127.0.0.1:{BACKEND_PORT}\r\n\
                     Connection: close\r\n\
                     X-PocketDeck-Expected-Process-Id: {}\r\n\r\n",
                child.id()
            );
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut response = Vec::new();
                if stream.read_to_end(&mut response).is_ok()
                    && health_response_matches(&response, child.id())
                {
                    if child
                        .try_wait()
                        .map_err(|error| {
                            format!("Could not confirm backend process status: {error}")
                        })?
                        .is_none()
                    {
                        return Ok(());
                    }
                }
            }
        }

        if Instant::now() >= deadline {
            return Err(format!(
                "The backend did not become healthy on 127.0.0.1:{BACKEND_PORT} within {} seconds.",
                STARTUP_TIMEOUT.as_secs()
            ));
        }
        thread::sleep(HEALTH_CHECK_INTERVAL);
    }
}

#[derive(Deserialize)]
struct WifiListenerStatus {
    port: u16,
    loopback_available: bool,
    certificate_sha256: Option<String>,
    certificate_expires_at: Option<u64>,
}

fn listener_port_from_response(
    response: &str,
    now_epoch_seconds: u64,
) -> Result<Option<u16>, String> {
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "The TLS listener status response was incomplete.".to_string())?;
    if !headers
        .lines()
        .next()
        .is_some_and(|status| status.starts_with("HTTP/1.1 200 "))
    {
        return Err("The authenticated TLS listener status request was rejected.".to_string());
    }
    let status: WifiListenerStatus = serde_json::from_str(body)
        .map_err(|error| format!("The TLS listener status response was invalid: {error}"))?;
    let fingerprint = status
        .certificate_sha256
        .unwrap_or_default()
        .replace(':', "");
    Ok((status.loopback_available
        && status.port > 0
        && fingerprint.len() == 64
        && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
        && status
            .certificate_expires_at
            .is_some_and(|expires_at| expires_at > now_epoch_seconds))
    .then_some(status.port))
}

fn authenticated_tls_listener_port(admin_token: &str) -> Result<Option<u16>, String> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, BACKEND_PORT));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500))
        .map_err(|error| format!("The PocketDeck backend status API is unavailable: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("Could not set the backend status timeout: {error}"))?;
    let request = format!(
        "GET /api/wifi/status HTTP/1.1\r\n\
         Host: 127.0.0.1:{BACKEND_PORT}\r\n\
         Authorization: Bearer {admin_token}\r\n\
         Connection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Could not query the TLS listener status: {error}"))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("Could not read the TLS listener status: {error}"))?;
    let response = std::str::from_utf8(&response)
        .map_err(|error| format!("The TLS listener status was not UTF-8: {error}"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("The system clock is invalid: {error}"))?
        .as_secs();
    listener_port_from_response(response, now)
}

#[cfg(windows)]
fn run_usb_reverse_monitor(stop: Arc<AtomicBool>, admin_token: String, log_path: PathBuf) {
    let mut last_error: Option<String> = None;
    let mut mapped_port: Option<u16> = None;
    let mut last_listener_state: Option<String> = None;
    let mut last_device_state: Option<String> = None;
    let mut last_tunnel_state: Option<String> = None;
    append_log(
        &log_path,
        &format!(
            "USB reverse monitor started; adb_executable='{}'; waiting for the authenticated TLS listener and an authorized USB device.",
            usb_transport::adb_executable_path().display()
        ),
    );
    while !stop.load(Ordering::Relaxed) {
        let listener_result = authenticated_tls_listener_port(&admin_token);
        match &listener_result {
            Ok(Some(port)) => append_log_when_changed(
                &log_path,
                &mut last_listener_state,
                format!("Authenticated TLS listener ready on 127.0.0.1:{port}."),
            ),
            Ok(None) => append_log_when_changed(
                &log_path,
                &mut last_listener_state,
                "Authenticated TLS listener is not ready on loopback; USB reverse mapping will not be advertised.".to_string(),
            ),
            Err(error) => append_log_when_changed(
                &log_path,
                &mut last_listener_state,
                format!("Could not verify authenticated TLS listener readiness: {error}"),
            ),
        }

        let devices_result = usb_transport::list_usb_devices_diagnostic(&log_path);
        if let Ok(devices) = &devices_result {
            let state = devices
                .iter()
                .map(|device| {
                    format!(
                        "serial={} state={} usb={}",
                        device.serial, device.state, device.is_usb
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            append_log_when_changed(
                &log_path,
                &mut last_device_state,
                if state.is_empty() {
                    "ADB reports no connected Android devices.".to_string()
                } else {
                    format!("ADB device state: {state}.")
                },
            );
        }
        let result = match (listener_result, devices_result) {
            (Ok(Some(port)), Ok(devices)) => (|| -> Result<(), String> {
                if let Some(previous_port) = mapped_port.filter(|previous| *previous != port) {
                    for device in devices
                        .iter()
                        .filter(|device| device.is_usb && device.state == "device")
                    {
                        if let Err(error) =
                            usb_transport::disable_reverse(&device.serial, previous_port)
                        {
                            append_log(
                                &log_path,
                                &format!("Could not refresh an old ADB reverse mapping: {error}"),
                            );
                        }
                    }
                }
                let mut found_authorized_usb_device = false;
                for device in devices
                    .iter()
                    .filter(|device| device.is_usb && device.state == "device")
                {
                    found_authorized_usb_device = true;
                    if usb_transport::ensure_reverse_diagnostic(&device.serial, port, &log_path)? {
                        append_log(
                        &log_path,
                        &format!(
                            "USB tunnel ready for serial={} state={} usb={}: adb reverse tcp:{port} tcp:{port} was established and confirmed by adb reverse --list.",
                            device.serial, device.state, device.is_usb
                        ),
                    );
                    } else {
                        append_log_when_changed(
                        &log_path,
                        &mut last_tunnel_state,
                        format!(
                            "USB tunnel already verified for serial={} state={} usb={}: adb reverse --list contains tcp:{port} tcp:{port}.",
                            device.serial, device.state, device.is_usb
                        ),
                    );
                    }
                }
                if found_authorized_usb_device {
                    mapped_port = Some(port);
                }
                Ok(())
            })(),
            (Ok(Some(_)), Err(error)) => Err(error),
            (Ok(None), Ok(_)) => Ok(()),
            (Ok(None), Err(error)) => Err(error),
            (Err(error), _) => Err(error),
        };

        match result {
            Ok(()) => {
                if last_error.take().is_some() {
                    append_log(
                        &log_path,
                        "USB reverse monitoring recovered; authorized devices will be checked for the ADB tunnel.",
                    );
                }
            }
            Err(error) if last_error.as_ref() != Some(&error) => {
                append_log(&log_path, &format!("USB reverse monitor: {error}"));
                last_error = Some(error);
            }
            Err(_) => {}
        }
        thread::sleep(USB_MONITOR_INTERVAL);
    }

    if let (Some(port), Ok(devices)) = (mapped_port, usb_transport::list_usb_devices()) {
        for device in devices
            .iter()
            .filter(|device| device.is_usb && device.state == "device")
        {
            if let Err(error) = usb_transport::disable_reverse(&device.serial, port) {
                append_log(
                    &log_path,
                    &format!("Could not remove an ADB reverse mapping at shutdown: {error}"),
                );
            }
        }
    }
    append_log(&log_path, "USB reverse monitor stopped.");
}

fn append_log_when_changed(log_path: &Path, previous: &mut Option<String>, message: String) {
    if previous.as_ref() != Some(&message) {
        append_log(log_path, &message);
        *previous = Some(message);
    }
}

fn health_response_matches(response: &[u8], process_id: u32) -> bool {
    let Ok(response) = std::str::from_utf8(response) else {
        return false;
    };
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let mut header_lines = headers.lines();
    if !header_lines
        .next()
        .is_some_and(|status| status.starts_with("HTTP/1.1 200 "))
    {
        return false;
    }
    let expected_process_id = process_id.to_string();
    let owns_health_response = header_lines.any(|header| {
        header.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("X-PocketDeck-Process-Id")
                && value.trim() == expected_process_id
        })
    });
    owns_health_response && body.trim() == r#"{"service":"PocketDeck Backend","status":"healthy"}"#
}

fn stop_child(child: &mut Child, log_path: &Path) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    if let Err(error) = child.kill() {
        append_log(
            log_path,
            &format!("Could not stop backend after startup failure: {error}"),
        );
    }
    if let Err(error) = child.wait() {
        append_log(
            log_path,
            &format!("Could not wait for backend after startup failure: {error}"),
        );
    }
}

fn append_log(path: &Path, message: &str) {
    if let Ok(mut log) = OpenOptions::new().append(true).open(path) {
        let _ = writeln!(log, "{message}");
    }
}

fn format_startup_error(error: &str, log_path: Option<&Path>) -> String {
    let log_details = log_path
        .map(|path| format!(" Backend log: {}", path.display()))
        .unwrap_or_default();
    format!(
        "Packaged backend startup failed. Check that port {BACKEND_PORT} is available, then close and reopen PocketDeck. PocketDeck will not stop any other process. Details: {error}{log_details}"
    )
}

fn should_start_hidden(mut arguments: impl Iterator<Item = String>) -> bool {
    arguments.any(|argument| argument == "--background")
}

#[tauri::command]
fn backend_startup_error(runtime: State<'_, BackendRuntime>) -> Option<String> {
    runtime
        .startup_error
        .lock()
        .expect("backend startup mutex poisoned")
        .clone()
}

#[tauri::command]
fn backend_admin_token(runtime: State<'_, BackendRuntime>) -> Result<String, String> {
    runtime
        .admin_token
        .lock()
        .map_err(|_| "Backend authentication state is unavailable.".to_string())?
        .clone()
        .or_else(|| std::env::var("POCKETDECK_ADMIN_TOKEN").ok())
        .ok_or_else(|| {
            "POCKETDECK_ADMIN_TOKEN is not set. Start the development backend and Tauri UI with the same private token.".to_string()
        })
}

#[tauri::command]
fn select_application_executable() -> Result<Option<String>, String> {
    application_picker::select_executable()
}

#[tauri::command]
fn save_configuration_export(contents: String) -> Result<bool, String> {
    configuration_export::save_configuration(&contents)
}

#[tauri::command]
fn list_usb_devices() -> Result<Vec<usb_transport::UsbDevice>, String> {
    usb_transport::list_usb_devices()
}

#[tauri::command]
fn enable_usb_reverse(serial: String, port: u16) -> Result<String, String> {
    usb_transport::enable_reverse(&serial, port)
}

#[tauri::command]
fn disable_usb_reverse(serial: String, port: u16) -> Result<String, String> {
    usb_transport::disable_reverse(&serial, port)
}

#[tauri::command]
fn get_launch_at_login() -> Result<bool, String> {
    companion_lifecycle::is_launch_at_login_enabled()
}

#[tauri::command]
fn set_launch_at_login(enabled: bool) -> Result<bool, String> {
    companion_lifecycle::set_launch_at_login(enabled)
}

fn open_studio(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.show() {
            eprintln!("Could not show PocketDeck studio: {error}");
            return;
        }
        if let Err(error) = window.set_focus() {
            eprintln!("Could not focus PocketDeck studio: {error}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendRuntime::default())
        .manage(shortcut_capture::Runtime::default())
        .setup(|app| {
            let instance_lock = CompanionInstanceLock::acquire().map_err(std::io::Error::other)?;
            if let Some(instance_lock) = instance_lock {
                app.manage(instance_lock);
            } else {
                std::process::exit(0);
            }

            let open = MenuItem::with_id(app, "open", "Open PocketDeck", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit PocketDeck", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| std::io::Error::other("PocketDeck tray icon is missing."))?;
            let tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("PocketDeck companion is running")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => open_studio(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        }
                    ) {
                        open_studio(tray.app_handle());
                    }
                })
                .build(app)?;
            app.manage(tray);
            if should_start_hidden(std::env::args()) {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide()?;
                }
            }

            #[cfg(all(not(debug_assertions), target_os = "windows"))]
            app.state::<BackendRuntime>().start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_startup_error,
            backend_admin_token,
            select_application_executable,
            save_configuration_export,
            list_usb_devices,
            enable_usb_reverse,
            disable_usb_reverse,
            get_launch_at_login,
            set_launch_at_login,
            shortcut_capture::start_shortcut_capture,
            shortcut_capture::stop_shortcut_capture
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("Could not hide PocketDeck studio: {error}");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building PocketDeck")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                app.state::<BackendRuntime>().stop();
                let _ = app.state::<shortcut_capture::Runtime>().stop();
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn usb_monitor_requires_live_loopback_tls_listener_and_unexpired_pin() {
        let valid = concat!(
            "HTTP/1.1 200 OK\r\n\r\n",
            r#"{"enabled":false,"loopback_available":true,"addresses":[],"port":8443,"server_id":"id","certificate_sha256":"AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA","certificate_expires_at":2000,"error":null}"#
        );
        let no_listener = concat!(
            "HTTP/1.1 200 OK\r\n\r\n",
            r#"{"enabled":false,"loopback_available":false,"addresses":[],"port":8443,"server_id":"id","certificate_sha256":"AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA","certificate_expires_at":2000,"error":"listener down"}"#
        );

        assert_eq!(
            super::listener_port_from_response(valid, 1000),
            Ok(Some(8443))
        );
        assert_eq!(
            super::listener_port_from_response(no_listener, 1000),
            Ok(None)
        );
        assert!(super::listener_port_from_response(valid, 2000)
            .expect("parse expired listener status")
            .is_none());
        assert!(
            super::listener_port_from_response("HTTP/1.1 401 Unauthorized\r\n\r\n{}", 1000)
                .is_err()
        );
    }

    #[cfg(windows)]
    #[test]
    fn packaged_backend_launch_explicitly_enables_authenticated_wifi() {
        use std::ffi::OsStr;
        use std::process::Command;

        let mut command = Command::new("pocketdeck-backend.exe");
        let window_flags = super::configure_backend_command(
            &mut command,
            "test-admin-token",
            std::path::Path::new("test-data"),
        );

        assert!(command.get_envs().any(|(key, value)| {
            key == OsStr::new(super::WIFI_ENABLE_ENV) && value == Some(OsStr::new("1"))
        }));
        assert_ne!(window_flags & super::windows_process::CREATE_NO_WINDOW, 0);
    }

    #[cfg(windows)]
    #[test]
    fn companion_lock_recovers_from_stale_files_and_blocks_active_instances() {
        use std::fs::{self, File};
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after the Unix epoch")
            .as_nanos();
        let lock_path = std::env::temp_dir().join(format!(
            "pocketdeck-companion-lock-{}-{nonce}",
            std::process::id()
        ));
        drop(File::create(&lock_path).expect("create a stale lock file"));

        let first = super::try_acquire_companion_lock(&lock_path)
            .expect("acquire stale lock file")
            .expect("stale lock file should be reusable");
        assert!(
            super::try_acquire_companion_lock(&lock_path)
                .expect("check active lock file")
                .is_none(),
            "another instance must not acquire an active lock"
        );
        drop(first);

        let next = super::try_acquire_companion_lock(&lock_path)
            .expect("reacquire released lock file")
            .expect("released lock should be reusable");
        drop(next);
        fs::remove_file(lock_path).expect("remove test lock file");
    }

    #[test]
    fn background_startup_argument_hides_the_studio_window() {
        assert!(super::should_start_hidden(
            ["pocketdeck.exe".to_string(), "--background".to_string()].into_iter()
        ));
        assert!(!super::should_start_hidden(
            ["pocketdeck.exe".to_string()].into_iter()
        ));
    }

    fn response(process_id: u32, body: &str) -> Vec<u8> {
        format!("HTTP/1.1 200 OK\r\nX-PocketDeck-Process-Id: {process_id}\r\n\r\n{body}")
            .into_bytes()
    }

    #[test]
    fn accepts_only_the_expected_healthy_backend_process() {
        let expected = response(
            1234,
            r#"{"service":"PocketDeck Backend","status":"healthy"}"#,
        );
        let other_process = response(
            4321,
            r#"{"service":"PocketDeck Backend","status":"healthy"}"#,
        );
        let wrong_service = response(1234, r#"{"service":"Other","status":"healthy"}"#);

        assert!(super::health_response_matches(&expected, 1234));
        assert!(!super::health_response_matches(&other_process, 1234));
        assert!(!super::health_response_matches(&wrong_service, 1234));
        assert!(!super::health_response_matches(
            b"not an HTTP response",
            1234
        ));
    }
}
