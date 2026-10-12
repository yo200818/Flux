use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug, Serialize)]
pub struct UsbDevice {
    pub serial: String,
    pub model: Option<String>,
    pub state: String,
    pub is_usb: bool,
}

fn adb_executable() -> PathBuf {
    let sdk_roots = [
        env::var_os("ANDROID_SDK_ROOT").map(PathBuf::from),
        env::var_os("ANDROID_HOME").map(PathBuf::from),
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("Android").join("Sdk")),
    ];
    for root in sdk_roots.into_iter().flatten() {
        let executable =
            root.join("platform-tools")
                .join(if cfg!(windows) { "adb.exe" } else { "adb" });
        if executable.is_file() {
            return executable;
        }
    }
    PathBuf::from(if cfg!(windows) { "adb.exe" } else { "adb" })
}

fn configure_adb_command(command: &mut Command, args: &[&str]) -> u32 {
    command.args(args);
    crate::windows_process::hide_console_window(command)
}

fn adb_command(args: &[&str]) -> Command {
    let mut command = Command::new(adb_executable());
    configure_adb_command(&mut command, args);
    command
}

pub fn adb_executable_path() -> PathBuf {
    adb_executable()
}

fn adb_output(args: &[&str]) -> Result<std::process::Output, String> {
    let executable = adb_executable();
    adb_command(args)
        .output()
        .map_err(|error| {
            format!(
                "Android Platform Tools (adb) could not be started at '{}'. Install platform-tools and authorize USB debugging. Details: {error}",
                executable.display()
            )
        })
}

fn run_adb(args: &[&str]) -> Result<String, String> {
    let output = adb_output(args)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ADB command failed (exit code {}): stdout='{}' stderr='{}'",
            output
                .status
                .code()
                .map_or_else(|| "unknown".to_string(), |code| code.to_string()),
            stdout.trim().chars().take(240).collect::<String>(),
            stderr.trim().chars().take(240).collect::<String>(),
        ));
    }
    Ok(stdout.into_owned())
}

fn run_adb_logged(args: &[&str], log_path: &std::path::Path) -> Result<String, String> {
    let executable = adb_executable();
    let result = adb_output(args)?;
    let stdout = String::from_utf8_lossy(&result.stdout);
    let stderr = String::from_utf8_lossy(&result.stderr);
    let output_summary = if args.get(0) == Some(&"devices") {
        format!(
            "{} device row(s)",
            stdout
                .lines()
                .skip(1)
                .filter(|line| !line.trim().is_empty())
                .count()
        )
    } else {
        format!(
            "stdout='{}'",
            stdout.trim().chars().take(512).collect::<String>()
        )
    };
    let message = format!(
        "ADB command: executable='{}' args='{}' exit_code={} {} stderr='{}'",
        executable.display(),
        args.join(" "),
        result
            .status
            .code()
            .map_or_else(|| "unknown".to_string(), |code| code.to_string()),
        output_summary,
        stderr.trim().chars().take(512).collect::<String>(),
    );
    log_adb_result_once(log_path, &args.join(" "), &message);
    if !result.status.success() {
        return Err(format!(
            "ADB command failed (exit code {}): stdout='{}' stderr='{}'",
            result
                .status
                .code()
                .map_or_else(|| "unknown".to_string(), |code| code.to_string()),
            stdout.trim().chars().take(240).collect::<String>(),
            stderr.trim().chars().take(240).collect::<String>(),
        ));
    }
    Ok(stdout.into_owned())
}

fn log_adb_result_once(log_path: &std::path::Path, command: &str, message: &str) {
    static LAST_RESULTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let key = format!("{}:{command}", log_path.display());
    let mut last_results = LAST_RESULTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("ADB diagnostics mutex poisoned");
    if last_results
        .get(&key)
        .is_some_and(|previous| previous == message)
    {
        return;
    }
    last_results.insert(key, message.to_string());
    if let Ok(mut log) = OpenOptions::new().append(true).open(log_path) {
        let _ = writeln!(log, "{message}");
    }
}

fn parse_devices(output: &str) -> Vec<UsbDevice> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let serial = fields.next()?;
            if serial == "List" {
                return None;
            }
            let state = fields.next()?;
            let details: Vec<_> = fields.collect();
            let model = details
                .iter()
                .find_map(|field| field.strip_prefix("model:"))
                .map(|value| value.replace('_', " "));
            Some(UsbDevice {
                serial: serial.to_string(),
                model,
                state: state.to_string(),
                is_usb: details.iter().any(|field| field.starts_with("usb:")),
            })
        })
        .collect()
}

pub fn list_usb_devices() -> Result<Vec<UsbDevice>, String> {
    Ok(parse_devices(&run_adb(&["devices", "-l"])?))
}

pub fn list_usb_devices_diagnostic(log_path: &std::path::Path) -> Result<Vec<UsbDevice>, String> {
    Ok(parse_devices(&run_adb_logged(
        &["devices", "-l"],
        log_path,
    )?))
}

fn reverse_mapping_present(output: &str, port: u16) -> bool {
    let expected = format!("tcp:{port}");
    output.lines().any(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        fields.len() >= 2
            && fields[fields.len() - 2] == expected
            && fields[fields.len() - 1] == expected
    })
}

fn validate_authorized_usb_device(serial: &str) -> Result<(), String> {
    if serial.is_empty()
        || !serial
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
    {
        return Err("The selected ADB device identifier is invalid.".to_string());
    }
    let devices = list_usb_devices()?;
    validate_usb_device(&devices, serial)
}

fn validate_usb_device(devices: &[UsbDevice], serial: &str) -> Result<(), String> {
    let device = devices
        .iter()
        .find(|device| device.serial == serial)
        .ok_or_else(|| "The selected Android device is no longer connected.".to_string())?;
    if !device.is_usb {
        return Err(
            "Select a device attached through USB, not an ADB network connection.".to_string(),
        );
    }
    if device.state != "device" {
        return Err(
            "Authorize USB debugging on the phone, then refresh the USB device list.".to_string(),
        );
    }
    Ok(())
}

fn ensure_reverse_mapping(
    serial: &str,
    port: u16,
    mut run: impl FnMut(&[&str]) -> Result<String, String>,
) -> Result<bool, String> {
    let port_arg = format!("tcp:{port}");
    let list_args = ["-s", serial, "reverse", "--list"];
    let current = run(&list_args)?;
    if reverse_mapping_present(&current, port) {
        return Ok(false);
    }

    let enable_args = ["-s", serial, "reverse", &port_arg, &port_arg];
    run(&enable_args)?;
    let verified = run(&list_args)?;
    if !reverse_mapping_present(&verified, port) {
        return Err(format!(
            "ADB did not confirm the USB reverse mapping on port {port}."
        ));
    }
    Ok(true)
}

pub fn ensure_reverse(serial: &str, port: u16) -> Result<bool, String> {
    validate_authorized_usb_device(serial)?;
    ensure_reverse_mapping(serial, port, run_adb)
}

pub fn ensure_reverse_diagnostic(
    serial: &str,
    port: u16,
    log_path: &std::path::Path,
) -> Result<bool, String> {
    if serial.is_empty()
        || !serial
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
    {
        return Err("The selected ADB device identifier is invalid.".to_string());
    }
    let devices = list_usb_devices_diagnostic(log_path)?;
    validate_usb_device(&devices, serial)?;
    ensure_reverse_mapping(serial, port, |args| run_adb_logged(args, log_path))
}

pub fn enable_reverse(serial: &str, port: u16) -> Result<String, String> {
    ensure_reverse(serial, port)?;
    Ok(format!(
        "USB reverse connection is verified on port {port}. Select USB in Android and connect."
    ))
}

pub fn disable_reverse(serial: &str, port: u16) -> Result<String, String> {
    validate_authorized_usb_device(serial)?;
    let port_arg = format!("tcp:{port}");
    run_adb(&["-s", serial, "reverse", "--remove", &port_arg])?;
    Ok(format!(
        "PocketDeck USB reverse connection on port {port} was removed."
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_reverse_mapping, parse_devices, reverse_mapping_present, validate_usb_device,
    };
    use std::collections::VecDeque;

    #[cfg(windows)]
    #[test]
    fn adb_commands_are_created_without_a_console_window() {
        use std::process::Command;

        let mut command = Command::new("adb.exe");
        let flags = super::configure_adb_command(&mut command, &["devices", "-l"]);
        assert_ne!(flags & crate::windows_process::CREATE_NO_WINDOW, 0);
    }

    #[test]
    fn parses_only_explicit_usb_transport_as_usb() {
        let devices = parse_devices(
            "List of devices attached\n\
             phone-serial device product:p model:Pocket_Phone device:phone usb:1-2 transport_id:4\n\
             192.168.1.8:5555 device product:p model:Network_Phone transport_id:5\n\
             other unauthorized usb:1-3\n",
        );

        assert_eq!(devices.len(), 3);
        assert!(devices[0].is_usb);
        assert_eq!(devices[0].model.as_deref(), Some("Pocket Phone"));
        assert!(!devices[1].is_usb);
        assert_eq!(devices[2].state, "unauthorized");
    }

    #[test]
    fn recognizes_only_the_requested_bidirectional_reverse_mapping() {
        assert!(reverse_mapping_present("tcp:8443 tcp:8443\n", 8443));
        assert!(reverse_mapping_present(
            "serial-1 tcp:8443 tcp:8443\n",
            8443
        ));
        assert!(!reverse_mapping_present("tcp:8000 tcp:8000\n", 8443));
        assert!(!reverse_mapping_present("tcp:8443 tcp:8000\n", 8443));
        assert!(!reverse_mapping_present("", 8443));
    }

    #[test]
    fn creates_and_verifies_reverse_before_reporting_ready() {
        let mut responses = VecDeque::from([
            String::new(),
            String::new(),
            "tcp:8443 tcp:8443\n".to_string(),
        ]);
        let mut calls = Vec::new();
        let created = ensure_reverse_mapping("phone", 8443, |args| {
            calls.push(args.join(" "));
            Ok(responses.pop_front().unwrap_or_default())
        });

        assert_eq!(created, Ok(true));
        assert_eq!(
            calls,
            [
                "-s phone reverse --list",
                "-s phone reverse tcp:8443 tcp:8443",
                "-s phone reverse --list",
            ]
        );
    }

    #[test]
    fn failed_reverse_command_never_reports_the_tunnel_ready() {
        let mut call = 0;
        let result = ensure_reverse_mapping("phone", 8443, |_| {
            call += 1;
            if call == 1 {
                Ok(String::new())
            } else {
                Err("unauthorized".to_string())
            }
        });

        assert_eq!(result, Err("unauthorized".to_string()));
    }

    #[test]
    fn rejects_missing_and_unauthorized_usb_devices() {
        let devices = parse_devices(
            "List of devices attached\n\
             phone device usb:1-2\n\
             waiting unauthorized usb:1-3\n",
        );

        assert!(validate_usb_device(&devices, "phone").is_ok());
        assert_eq!(
            validate_usb_device(&devices, "waiting"),
            Err("Authorize USB debugging on the phone, then refresh the USB device list.".into())
        );
        assert_eq!(
            validate_usb_device(&devices, "missing"),
            Err("The selected Android device is no longer connected.".into())
        );
    }
}
