# Windows Manual Test Checklist

- Add a workspace using a real Windows path.
- Configure a direct command agent such as `cmd.exe` or `claude`.
- Configure a `.cmd` launcher.
- Configure a `.bat` launcher.
- Launch an agent and verify an interactive xterm terminal opens.
- Type text, press Enter, use Backspace and arrow keys.
- Send Ctrl+C using the terminal keyboard.
- Open two to four sessions in split panes and drag the separator.
- Close the browser tab and confirm the backend process and agent process remain alive.
- Reopen the frontend and confirm `/api/state` restores the running session list.
- Stop a session and confirm it moves to history.
- Force terminate only after confirmation.
- Kill an agent externally and confirm status changes to `CRASHED` or `DISCONNECTED`.
- Restart Windows and confirm previous active sessions are not auto-launched.
- Resume only a session whose agent definition supports resume.

Known limitation: I verified build and API smoke tests here, but full Windows reboot and real Claude/Codex interactive acceptance testing must be performed manually on the target machine.
