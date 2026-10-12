use std::process::Command;

const RUN_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "PocketDeck";

fn run_registry(args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new("reg.exe");
    command.args(args);
    crate::windows_process::hide_console_window(&mut command);
    command
        .output()
        .map_err(|error| format!("Could not update PocketDeck Windows startup settings: {error}"))
}

pub fn is_launch_at_login_enabled() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let output = run_registry(&["query", RUN_KEY, "/v", RUN_VALUE])?;
        if output.status.success() {
            return Ok(true);
        }
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if error.contains("unable to find the specified registry key or value") {
            return Ok(false);
        }
        return Err(format!(
            "Windows could not read PocketDeck startup settings: {}",
            error.chars().take(240).collect::<String>()
        ));
    }
    #[cfg(not(windows))]
    {
        Err("Windows startup settings are available only in the Windows app.".to_string())
    }
}

pub fn set_launch_at_login(enabled: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        if enabled {
            let executable = std::env::current_exe()
                .map_err(|error| format!("Could not locate PocketDeck.exe: {error}"))?;
            let command = format!("\"{}\" --background", executable.display());
            let output = run_registry(&[
                "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &command, "/f",
            ])?;
            if !output.status.success() {
                return Err(format!(
                    "Windows could not enable PocketDeck startup: {}",
                    String::from_utf8_lossy(&output.stderr)
                        .trim()
                        .chars()
                        .take(240)
                        .collect::<String>()
                ));
            }
        } else if is_launch_at_login_enabled()? {
            let output = run_registry(&["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])?;
            if !output.status.success() {
                return Err(format!(
                    "Windows could not disable PocketDeck startup: {}",
                    String::from_utf8_lossy(&output.stderr)
                        .trim()
                        .chars()
                        .take(240)
                        .collect::<String>()
                ));
            }
        }
        return Ok(enabled);
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Windows startup settings are available only in the Windows app.".to_string())
    }
}
