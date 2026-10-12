use std::process::Command;

#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn hide_console_window(command: &mut Command) -> u32 {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
        CREATE_NO_WINDOW
    }

    #[cfg(not(windows))]
    {
        let _ = command;
        0
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::{hide_console_window, CREATE_NO_WINDOW};
    use std::process::Command;

    #[test]
    fn noninteractive_child_processes_use_create_no_window() {
        let mut command = Command::new("noninteractive-child.exe");

        let flags = hide_console_window(&mut command);

        assert_eq!(flags, CREATE_NO_WINDOW);
    }
}
