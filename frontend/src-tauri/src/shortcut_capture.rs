use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutCaptureEvent {
    kind: &'static str,
    modifiers: Vec<&'static str>,
    shortcut: Option<String>,
    key: Option<String>,
}

#[cfg(target_os = "windows")]
mod windows {
    use super::ShortcutCaptureEvent;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
    use std::sync::mpsc::{self, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};

    type HookHandle = *mut c_void;

    const HC_ACTION: i32 = 0;
    const WH_KEYBOARD_LL: i32 = 13;
    const WM_KEYDOWN: u32 = 0x0100;
    const WM_KEYUP: u32 = 0x0101;
    const WM_SYSKEYDOWN: u32 = 0x0104;
    const WM_SYSKEYUP: u32 = 0x0105;
    const WM_QUIT: u32 = 0x0012;
    const WM_APP_CAPTURE: u32 = 0x8001;
    const VK_SHIFT: u32 = 0x10;
    const VK_CONTROL: u32 = 0x11;
    const VK_MENU: u32 = 0x12;
    const VK_LWIN: u32 = 0x5b;
    const VK_RWIN: u32 = 0x5c;
    const VK_LSHIFT: u32 = 0xa0;
    const VK_RSHIFT: u32 = 0xa1;
    const VK_LCONTROL: u32 = 0xa2;
    const VK_RCONTROL: u32 = 0xa3;
    const VK_LMENU: u32 = 0xa4;
    const VK_RMENU: u32 = 0xa5;

    const MOD_CTRL_LEFT: u32 = 1;
    const MOD_CTRL_RIGHT: u32 = 2;
    const MOD_ALT_LEFT: u32 = 4;
    const MOD_ALT_RIGHT: u32 = 8;
    const MOD_SHIFT_LEFT: u32 = 16;
    const MOD_SHIFT_RIGHT: u32 = 32;
    const MOD_WIN_LEFT: u32 = 64;
    const MOD_WIN_RIGHT: u32 = 128;

    #[repr(C)]
    struct KeyboardHookData {
        virtual_key: u32,
        scan_code: u32,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct Message {
        window: *mut c_void,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: u32,
        point: Point,
        private: u32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetWindowsHookExW(
            hook_type: i32,
            procedure: Option<unsafe extern "system" fn(i32, usize, isize) -> isize>,
            module: *mut c_void,
            thread_id: u32,
        ) -> HookHandle;
        fn UnhookWindowsHookEx(hook: HookHandle) -> i32;
        fn CallNextHookEx(hook: HookHandle, code: i32, w_param: usize, l_param: isize) -> isize;
        fn GetMessageW(message: *mut Message, window: *mut c_void, min: u32, max: u32) -> i32;
        fn TranslateMessage(message: *const Message) -> i32;
        fn DispatchMessageW(message: *const Message) -> isize;
        fn PostThreadMessageW(thread_id: u32, message: u32, w_param: usize, l_param: isize) -> i32;
        fn PeekMessageW(
            message: *mut Message,
            window: *mut c_void,
            min: u32,
            max: u32,
            remove: u32,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThreadId() -> u32;
        fn GetModuleHandleW(module_name: *const u16) -> *mut c_void;
    }

    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static MODIFIERS: AtomicU32 = AtomicU32::new(0);
    static LAST_KEY: AtomicU32 = AtomicU32::new(0);
    static HOOK_THREAD_ID: AtomicUsize = AtomicUsize::new(0);
    static EVENT_SENDER: OnceLock<Mutex<Option<Sender<ShortcutCaptureEvent>>>> = OnceLock::new();

    pub struct Runtime {
        session: Mutex<Option<Session>>,
    }

    struct Session {
        thread_id: u32,
        thread: JoinHandle<()>,
    }

    impl Default for Runtime {
        fn default() -> Self {
            Self {
                session: Mutex::new(None),
            }
        }
    }

    impl Runtime {
        pub fn start(&self, app: AppHandle) -> Result<(), String> {
            let mut session = self
                .session
                .lock()
                .map_err(|_| "Shortcut capture state is unavailable.".to_string())?;
            if session.is_some() {
                return Ok(());
            }

            let (event_sender, event_receiver) = mpsc::channel();
            let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
            *EVENT_SENDER
                .get_or_init(|| Mutex::new(None))
                .lock()
                .map_err(|_| "Shortcut capture event state is unavailable.".to_string())? =
                Some(event_sender);
            ACTIVE.store(false, Ordering::SeqCst);
            MODIFIERS.store(0, Ordering::SeqCst);
            LAST_KEY.store(0, Ordering::SeqCst);

            let thread = thread::Builder::new()
                .name("pocketdeck-shortcut-capture".to_string())
                .spawn(move || hook_thread(app, event_receiver, ready_sender))
                .map_err(|error| {
                    clear_event_sender();
                    format!("Could not start native shortcut capture: {error}")
                })?;

            let thread_id = match ready_receiver.recv_timeout(Duration::from_secs(3)) {
                Ok(Ok(thread_id)) => thread_id,
                Ok(Err(error)) => {
                    let _ = thread.join();
                    clear_event_sender();
                    return Err(error);
                }
                Err(error) => {
                    let thread_id = HOOK_THREAD_ID.load(Ordering::SeqCst) as u32;
                    if thread_id != 0 {
                        unsafe {
                            PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
                        }
                    }
                    let _ = thread.join();
                    HOOK_THREAD_ID.store(0, Ordering::SeqCst);
                    clear_event_sender();
                    return Err(format!(
                        "Native shortcut capture did not initialize: {error}."
                    ));
                }
            };
            HOOK_THREAD_ID.store(thread_id as usize, Ordering::SeqCst);
            ACTIVE.store(true, Ordering::SeqCst);
            *session = Some(Session { thread_id, thread });
            Ok(())
        }

        pub fn stop(&self) -> Result<(), String> {
            ACTIVE.store(false, Ordering::SeqCst);
            MODIFIERS.store(0, Ordering::SeqCst);
            LAST_KEY.store(0, Ordering::SeqCst);
            clear_event_sender();
            let session = self
                .session
                .lock()
                .map_err(|_| "Shortcut capture state is unavailable.".to_string())?
                .take();
            if let Some(session) = session {
                unsafe {
                    PostThreadMessageW(session.thread_id, WM_QUIT, 0, 0);
                }
                session
                    .thread
                    .join()
                    .map_err(|_| "Native shortcut capture did not stop cleanly.".to_string())?;
            }
            HOOK_THREAD_ID.store(0, Ordering::SeqCst);
            Ok(())
        }
    }

    impl Drop for Runtime {
        fn drop(&mut self) {
            let _ = self.stop();
        }
    }

    fn clear_event_sender() {
        if let Some(sender) = EVENT_SENDER.get() {
            if let Ok(mut sender) = sender.lock() {
                *sender = None;
            }
        }
    }

    fn hook_thread(
        app: AppHandle,
        event_receiver: mpsc::Receiver<ShortcutCaptureEvent>,
        ready_sender: mpsc::SyncSender<Result<u32, String>>,
    ) {
        let thread_id = unsafe { GetCurrentThreadId() };
        let mut message = unsafe { std::mem::zeroed::<Message>() };
        unsafe {
            PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, 0);
        }
        HOOK_THREAD_ID.store(thread_id as usize, Ordering::SeqCst);
        let hook = unsafe {
            SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(keyboard_hook),
                GetModuleHandleW(std::ptr::null()),
                0,
            )
        };
        if hook.is_null() {
            HOOK_THREAD_ID.store(0, Ordering::SeqCst);
            let _ = ready_sender.send(Err(format!(
                "Windows could not install the temporary keyboard capture hook (error {}).",
                std::io::Error::last_os_error()
            )));
            return;
        }
        if ready_sender.send(Ok(thread_id)).is_err() {
            unsafe {
                UnhookWindowsHookEx(hook);
            }
            HOOK_THREAD_ID.store(0, Ordering::SeqCst);
            return;
        }

        loop {
            let result = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
            if result <= 0 || message.message == WM_QUIT {
                break;
            }
            if message.message != WM_APP_CAPTURE {
                unsafe {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            while let Ok(event) = event_receiver.try_recv() {
                let _ = app.emit("shortcut-capture-event", event);
            }
        }
        ACTIVE.store(false, Ordering::SeqCst);
        unsafe {
            UnhookWindowsHookEx(hook);
        }
        HOOK_THREAD_ID.store(0, Ordering::SeqCst);
    }

    unsafe extern "system" fn keyboard_hook(code: i32, w_param: usize, l_param: isize) -> isize {
        if !should_suppress(code, ACTIVE.load(Ordering::SeqCst)) {
            return CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param);
        }
        let is_down = matches!(w_param as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
        let is_up = matches!(w_param as u32, WM_KEYUP | WM_SYSKEYUP);
        if !is_down && !is_up {
            return CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param);
        }

        let key_data = &*(l_param as *const KeyboardHookData);
        let virtual_key = key_data.virtual_key;
        if let Some((modifier, name)) = modifier_for(virtual_key) {
            if update_modifier_state(&MODIFIERS, modifier, is_down) {
                send_event(ShortcutCaptureEvent {
                    kind: "modifier",
                    modifiers: modifier_names(MODIFIERS.load(Ordering::SeqCst)),
                    shortcut: None,
                    key: Some(name.to_string()),
                });
                post_capture_message();
            }
            return 1;
        }

        if is_up {
            let was_captured = LAST_KEY
                .compare_exchange(virtual_key, 0, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok();
            if was_captured {
                post_capture_message();
                return 1;
            }
            return CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param);
        }

        let modifier_bits = MODIFIERS.load(Ordering::SeqCst);
        if !should_capture_key_down(virtual_key, modifier_bits) {
            return CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param);
        }

        if LAST_KEY.swap(virtual_key, Ordering::SeqCst) != virtual_key {
            let key = key_name(virtual_key);
            let modifiers = modifier_names(modifier_bits);
            let shortcut = build_shortcut(&modifiers, &key);
            send_event(ShortcutCaptureEvent {
                kind: if shortcut.is_some() {
                    "shortcut"
                } else {
                    "unsupported"
                },
                modifiers,
                shortcut,
                key: Some(key),
            });
        }
        post_capture_message();
        1
    }

    pub(super) fn should_suppress(code: i32, active: bool) -> bool {
        code == HC_ACTION && active
    }

    pub(super) fn should_capture_key_down(virtual_key: u32, modifiers: u32) -> bool {
        modifiers != 0 || virtual_key == 0x2c
    }

    pub(super) fn update_modifier_state(
        modifiers: &AtomicU32,
        modifier: u32,
        is_down: bool,
    ) -> bool {
        let previous = if is_down {
            modifiers.fetch_or(modifier, Ordering::SeqCst)
        } else {
            modifiers.fetch_and(!modifier, Ordering::SeqCst)
        };
        (previous & modifier != 0) != is_down
    }

    fn modifier_for(virtual_key: u32) -> Option<(u32, &'static str)> {
        match virtual_key {
            VK_CONTROL | VK_LCONTROL => Some((MOD_CTRL_LEFT, "CTRL")),
            VK_RCONTROL => Some((MOD_CTRL_RIGHT, "CTRL")),
            VK_MENU | VK_LMENU => Some((MOD_ALT_LEFT, "ALT")),
            VK_RMENU => Some((MOD_ALT_RIGHT, "ALT")),
            VK_SHIFT | VK_LSHIFT => Some((MOD_SHIFT_LEFT, "SHIFT")),
            VK_RSHIFT => Some((MOD_SHIFT_RIGHT, "SHIFT")),
            VK_LWIN => Some((MOD_WIN_LEFT, "WIN")),
            VK_RWIN => Some((MOD_WIN_RIGHT, "WIN")),
            _ => None,
        }
    }

    fn modifier_names(bits: u32) -> Vec<&'static str> {
        let mut names = Vec::new();
        if bits & (MOD_CTRL_LEFT | MOD_CTRL_RIGHT) != 0 {
            names.push("CTRL");
        }
        if bits & (MOD_ALT_LEFT | MOD_ALT_RIGHT) != 0 {
            names.push("ALT");
        }
        if bits & (MOD_SHIFT_LEFT | MOD_SHIFT_RIGHT) != 0 {
            names.push("SHIFT");
        }
        if bits & (MOD_WIN_LEFT | MOD_WIN_RIGHT) != 0 {
            names.push("WIN");
        }
        names
    }

    fn key_name(virtual_key: u32) -> String {
        if (0x30..=0x39).contains(&virtual_key) || (0x41..=0x5a).contains(&virtual_key) {
            return char::from_u32(virtual_key)
                .expect("ASCII virtual key is a valid character")
                .to_string();
        }
        match virtual_key {
            0x60..=0x69 => match virtual_key {
                0x60 => "NUMPAD0",
                0x61 => "NUMPAD1",
                0x62 => "NUMPAD2",
                0x63 => "NUMPAD3",
                0x64 => "NUMPAD4",
                0x65 => "NUMPAD5",
                0x66 => "NUMPAD6",
                0x67 => "NUMPAD7",
                0x68 => "NUMPAD8",
                _ => "NUMPAD9",
            },
            0x70..=0x87 => match virtual_key {
                0x70 => "F1",
                0x71 => "F2",
                0x72 => "F3",
                0x73 => "F4",
                0x74 => "F5",
                0x75 => "F6",
                0x76 => "F7",
                0x77 => "F8",
                0x78 => "F9",
                0x79 => "F10",
                0x7a => "F11",
                0x7b => "F12",
                0x7c => "F13",
                0x7d => "F14",
                0x7e => "F15",
                0x7f => "F16",
                0x80 => "F17",
                0x81 => "F18",
                0x82 => "F19",
                0x83 => "F20",
                0x84 => "F21",
                0x85 => "F22",
                0x86 => "F23",
                _ => "F24",
            },
            0x08 => "BACKSPACE",
            0x09 => "TAB",
            0x0d => "ENTER",
            0x1b => "ESC",
            0x20 => "SPACE",
            0x21 => "PAGEUP",
            0x22 => "PAGEDOWN",
            0x23 => "END",
            0x24 => "HOME",
            0x25 => "LEFT",
            0x26 => "UP",
            0x27 => "RIGHT",
            0x28 => "DOWN",
            0x2c => "PRINTSCREEN",
            0x2d => "INSERT",
            0x2e => "DELETE",
            0x6a => "NUMPADMULTIPLY",
            0x6b => "NUMPADADD",
            0x6d => "NUMPADSUBTRACT",
            0x6e => "NUMPADDECIMAL",
            0x6f => "NUMPADDIVIDE",
            0xba => "SEMICOLON",
            0xbb => "EQUAL",
            0xbc => "COMMA",
            0xbd => "MINUS",
            0xbe => "PERIOD",
            0xbf => "SLASH",
            0xc0 => "BACKQUOTE",
            0xdb => "BRACKETLEFT",
            0xdc => "BACKSLASH",
            0xdd => "BRACKETRIGHT",
            0xde => "QUOTE",
            _ => "UNSUPPORTED",
        }
        .to_string()
    }

    fn send_event(event: ShortcutCaptureEvent) {
        if let Some(sender) = EVENT_SENDER.get() {
            if let Ok(sender) = sender.lock() {
                if let Some(sender) = sender.as_ref() {
                    let _ = sender.send(event);
                }
            }
        }
    }

    fn post_capture_message() {
        let thread_id = HOOK_THREAD_ID.load(Ordering::SeqCst) as u32;
        if thread_id != 0 {
            unsafe {
                PostThreadMessageW(thread_id, WM_APP_CAPTURE, 0, 0);
            }
        }
    }

    pub fn build_shortcut(modifiers: &[&str], key: &str) -> Option<String> {
        if matches!(key, "UNSUPPORTED" | "PRINTSCREEN") || modifiers.is_empty() {
            return None;
        }
        let mut parts = modifiers.to_vec();
        parts.push(key);
        Some(parts.join("+"))
    }

    #[cfg(test)]
    fn supported_virtual_key(virtual_key: u32) -> bool {
        matches!(
            virtual_key,
            0x08..=0x09
                | 0x0d
                | 0x1b
                | 0x20..=0x28
                | 0x2c..=0x2e
                | 0x30..=0x39
                | 0x41..=0x5a
                | 0x60..=0x69
                | 0x6a..=0x6f
                | 0x70..=0x87
                | 0xba..=0xc0
                | 0xdb..=0xde
        )
    }

    #[cfg(test)]
    pub fn test_event(virtual_key: u32, modifier_bits: u32) -> Result<String, &'static str> {
        let key = key_name(virtual_key);
        if !supported_virtual_key(virtual_key) {
            return Err("unsupported");
        }
        let modifiers = modifier_names(modifier_bits);
        build_shortcut(&modifiers, &key).ok_or("unsupported")
    }
}

#[cfg(not(target_os = "windows"))]
mod windows {
    use std::sync::Mutex;
    use tauri::AppHandle;

    #[derive(Default)]
    pub struct Runtime {
        active: Mutex<bool>,
    }

    impl Runtime {
        pub fn start(&self, _app: AppHandle) -> Result<(), String> {
            *self
                .active
                .lock()
                .map_err(|_| "Shortcut capture state is unavailable.".to_string())? = true;
            Err("Native shortcut capture is available only on Windows.".to_string())
        }

        pub fn stop(&self) -> Result<(), String> {
            *self
                .active
                .lock()
                .map_err(|_| "Shortcut capture state is unavailable.".to_string())? = false;
            Ok(())
        }
    }

    impl Drop for Runtime {
        fn drop(&mut self) {
            let _ = self.stop();
        }
    }

    pub fn build_shortcut(_modifiers: &[&str], _key: &str) -> Option<String> {
        None
    }

    pub fn supported_virtual_key(_virtual_key: u32) -> bool {
        false
    }

    pub fn test_event(_virtual_key: u32, _modifier_bits: u32) -> Result<String, &'static str> {
        Err("unsupported")
    }
}

pub use windows::Runtime;

#[tauri::command]
pub fn start_shortcut_capture(app: AppHandle, runtime: State<'_, Runtime>) -> Result<(), String> {
    runtime.start(app)
}

#[tauri::command]
pub fn stop_shortcut_capture(runtime: State<'_, Runtime>) -> Result<(), String> {
    runtime.stop()
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    #[test]
    fn maps_win_shift_s_and_print_screen_for_capture() {
        const MOD_SHIFT_LEFT: u32 = 16;
        const MOD_WIN_LEFT: u32 = 64;
        const MOD_CTRL_LEFT: u32 = 1;
        assert_eq!(
            super::windows::test_event(0x53, MOD_SHIFT_LEFT | MOD_WIN_LEFT),
            Ok("SHIFT+WIN+S".to_string())
        );
        assert_eq!(
            super::windows::test_event(0x87, MOD_CTRL_LEFT),
            Ok("CTRL+F24".to_string())
        );
        assert_eq!(
            super::windows::test_event(0x25, MOD_CTRL_LEFT),
            Ok("CTRL+LEFT".to_string())
        );
        assert_eq!(
            super::windows::test_event(0x61, MOD_CTRL_LEFT),
            Ok("CTRL+NUMPAD1".to_string())
        );
        assert_eq!(super::windows::test_event(0x2c, 0), Err("unsupported"));
        assert_eq!(
            super::windows::test_event(0x2c, MOD_CTRL_LEFT),
            Err("unsupported")
        );
        assert_eq!(
            super::windows::test_event(0x07, MOD_CTRL_LEFT),
            Err("unsupported")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn native_hook_suppresses_only_while_capture_is_active() {
        assert!(super::windows::should_suppress(0, true));
        assert!(!super::windows::should_suppress(0, false));
        assert!(!super::windows::should_suppress(-1, true));
        assert!(super::windows::should_capture_key_down(0x2c, 0));
        assert!(!super::windows::should_capture_key_down(0x41, 0));
        assert!(super::windows::should_capture_key_down(0x41, 1));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn modifier_repeats_do_not_duplicate_or_stick_state() {
        use std::sync::atomic::AtomicU32;

        let modifiers = AtomicU32::new(0);
        assert!(super::windows::update_modifier_state(&modifiers, 1, true));
        assert!(!super::windows::update_modifier_state(&modifiers, 1, true));
        assert_eq!(modifiers.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(super::windows::update_modifier_state(&modifiers, 1, false));
        assert!(!super::windows::update_modifier_state(&modifiers, 1, false));
        assert_eq!(modifiers.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}
