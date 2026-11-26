---
name: run-on-windows
description: Run this project on Windows — natively when the host is Windows; from macOS either inside a Parallels Desktop Windows VM or on a separate Windows machine over SSH, whichever the user picks. Use when asked to run, launch, dev-test or debug voxpane on Windows from a Mac, to check the Windows build/helper, or when Parallels or an SSH Windows target needs to be set up for that.
---

# Run on Windows

Bring up `voxpane` on Windows. On a Windows host that is just a local run. On macOS it means
driving Windows from the command line, through one of two targets the user chooses:

- **Parallels** — a Parallels Desktop Windows VM on this Mac (`prlctl`).
- **SSH** — a separate Windows machine running OpenSSH Server (`ssh` / `scp`).

Getting the app running is only half of it: the overlay draws nothing without the bridge
script, and on Windows the geometry comes from a different source than on macOS. Read
[`docs/geometry.md`](../../../docs/geometry.md) before debugging anything positional here, and
[`docs/debugging.md`](../../../docs/debugging.md) for what to check once it is up.

This skill has to behave identically under Claude Code and Codex, so the work itself is done
only with shell commands. The one exception is **asking the user to choose**: use the
harness's own tool for putting choices to the user — `AskUserQuestion` in Claude Code, the
equivalent user-input tool in Codex (`request_user_input`) — and fall back to a plain-text
question, then wait for the answer, only when the harness has no such tool.

Every step below is a gate: if a gate fails, report exactly what failed and stop — do not
improvise around a missing VM, an unreachable host, a missing toolchain, or a missing licence.

## Rules

- **Never install anything** — on the host, in the guest, or on the remote machine — without
  the user saying yes first. Propose the exact command and wait.
- **Never `prlctl stop`, `suspend`, `reset`, `delete`, `snapshot-delete`, or reconfigure a VM.**
  Starting a stopped VM is allowed; everything else that changes VM state needs the user's go-ahead.
- **Never change the remote machine's setup over SSH** — `sshd_config`, its `DefaultShell`,
  `authorized_keys`, the firewall, services, user accounts — and never reboot, log off or shut
  it down. Propose and wait. Likewise never edit `~/.ssh/config` on the Mac without a yes, and
  never pass `StrictHostKeyChecking=no` to get past an unknown host key.
- **Never build or run out of a shared folder or a mount.** `node_modules`, Cargo's `target/`
  and the `.node` that `napi build` emits into `packages/windows-helper` are all
  platform-specific; a Windows build inside the Mac checkout corrupts the host's `pnpm dev`.
  Always mirror into a directory local to the Windows machine — the Parallels share
  `\\Mac\…` and any SMB-mounted drive on the SSH target count as shared.
- The repo root is `git rev-parse --show-toplevel`, not the current directory.

## 1. Host check

```sh
uname -s   # Darwin = macOS; MINGW*/MSYS*/CYGWIN* = Windows shell
```

- **Windows host** — no VM involved. Run in the repo root: `pnpm install`, then `pnpm dev`.
  Turbo's `dev` depends on `^build`, so that builds `@voxpane/windows-helper` first — one
  `napi build` producing a Node-API binary that Node *and* Electron both load, which is why
  there is no `@electron/rebuild` step. Report the result and stop; the rest of this skill
  does not apply.
- **macOS host** — continue to step 2.
- **Anything else** — say Windows runs are only supported from Windows, or from macOS through
  Parallels or SSH, and stop.

## 2. Pick the target: Parallels or SSH

The choice lives in `.context/run-on-windows.json` (gitignored), one block per target so that
switching back and forth does not lose either:

```json
{
  "target": "ssh",
  "parallels": { "vmUuid": "...", "vmName": "...", "guestPath": "C:\\dev\\voxpane" },
  "ssh": { "host": "win-box", "shell": "cmd", "guestPath": "C:\\dev\\voxpane" }
}
```

A file from before this step existed has `vmUuid` at the top level and no `target`: read it as
`"target": "parallels"` with that block, and write it back in the new shape.

Then, in order:

1. **The request already names a target** ("over SSH", "in the VM", a host name) — use it,
   even if the cache says otherwise, and update the cache.
2. **A cached `target` exists** — do not ask again. Say which target is being used in the first
   progress message (`Using SSH → win-box (cached; say "switch" to pick another)`), then
   continue on that path. Its first gates re-validate it — the VM UUID in P2, the host in S2.
   If one fails because the cached target is gone, say so and fall through to the question
   below rather than stopping.
3. **No cache, a stale one, or the user asks to switch** — ask with the user-choice tool:

   > How should I run voxpane on Windows from this Mac?
   >
   > - **Parallels** — a Windows VM in Parallels Desktop on this Mac.
   > - **SSH** — a separate Windows machine reachable over SSH.

   Check `test -d "/Applications/Parallels Desktop.app"` first; if it is absent, keep the
   option but say so in its description (`Parallels Desktop is not installed here`). Put the
   previously cached target first when there is one.

Write `target` to the cache as soon as it is chosen, then follow the **Parallels path** (P1–P6)
or the **SSH path** (S1–S6). Both end in [The bridge script](#the-bridge-script) and
[Report](#report).

## Parallels path

### P1. Parallels Desktop: running → installed → absent

Resolve `prlctl` first; it is not always on `PATH`:

```sh
PRLCTL=$(command -v prlctl || echo /usr/local/bin/prlctl)
```

Then walk the ladder:

1. **Running?** `pgrep -x prl_disp_service` (the dispatcher — `prlctl` needs it) and
   `"$PRLCTL" list --all` succeeding. If both are fine, go to P2.
2. **Installed?** `test -x "$PRLCTL"` or `test -d "/Applications/Parallels Desktop.app"`.
   If installed but not running: `open -a "Parallels Desktop"`, then poll
   `"$PRLCTL" list --all` every 3s for up to 60s. If it never answers, report the last error
   (an expired licence or a pending upgrade prompt shows up here) and stop.
3. **Not installed** — stop and offer, do not act:

   > Parallels Desktop isn't installed. I can install it with
   > `brew install --cask parallels`, or you can get it from
   > <https://www.parallels.com/products/desktop/>. It's a paid product and needs a licence
   > and a Windows VM before I can run anything. Want me to install it — or use a Windows
   > machine over SSH instead?

   Only run the install after an explicit yes; afterwards the user still has to sign in and
   create a Windows VM, so hand back at that point. If they pick SSH, update `target` and go to S1.

### P2. Pick the Windows VM

```sh
"$PRLCTL" list --all --json
```

Identify the Windows guests (`"$PRLCTL" list <uuid> --info | grep -i '^OS:'` if the names are
ambiguous). One Windows VM → use it. Several → ask which one with the user-choice tool. None →
stop and tell the user a Windows VM has to be created in Parallels first (the Parallels
installer assistant does this).

Cache the choice and the guest path in the `parallels` block of `.context/run-on-windows.json`
and reuse it on later runs, re-validating that the UUID still exists.

### P3. Boot the guest

If status is not `running`: `"$PRLCTL" start <uuid>`, then poll `"$PRLCTL" list <uuid> --json`
for `"status": "running"` (up to 2 min).

Windows being "running" is not enough — Parallels Tools must be up and a user logged in:

```sh
"$PRLCTL" exec <uuid> cmd.exe /c echo ready
```

Poll every 5s for up to 3 min. If it keeps failing, report that `prlctl exec` is unavailable —
usually Parallels Tools are missing or the guest sits at the lock screen — and stop. The Electron
window needs an interactive desktop session anyway.

#### Run everything as the logged-in user

`prlctl exec` runs as **`nt authority\system` in session 0** by default. That breaks three
things at once: the Electron window opens on an invisible desktop, `pnpm install` leaves
`node_modules` that the real user cannot open (`EPERM` on `turbo`), and anything installed
per-user — `rustup`'s `cargo`/`napi` shims, for one — is not on `PATH`.

So pass `--current-user` to every `prlctl exec` that installs, builds or runs:

```sh
"$PRLCTL" exec --current-user <uuid> cmd.exe /c "whoami"   # expect <host>\<user>, not nt authority\system
```

If a previous run already installed as SYSTEM, hand the tree back before running:
`icacls C:\dev\voxpane /grant <user>:(OI)(CI)M /T /Q /C` (minutes; ~84k files).

### P4. Mirror the repo into the guest

The Mac home directory is `\\Mac\Home` inside the guest — but by default Parallels shares
only Desktop, Documents and Downloads through it, so a repo elsewhere in `$HOME` is not
there. Check first:

```sh
"$PRLCTL" exec <uuid> cmd.exe /c "dir \\Mac\<share>"
```

If the repo is not reachable, propose adding a **read-only** share for it and wait for a yes
(this changes VM configuration):

```sh
"$PRLCTL" set <uuid> --shf-host on
"$PRLCTL" set <uuid> --shf-host-add voxpane --path <repo root> --mode ro
```

Read-only on purpose: it makes the "never build in the share" rule unbreakable rather than
merely stated. Remove it later with `--shf-host-del voxpane`.

Then mirror into `C:\dev\voxpane`, skipping everything platform-specific:

```sh
"$PRLCTL" exec <uuid> cmd.exe /c 'robocopy "\\Mac\voxpane" "C:\dev\voxpane" /MIR /R:1 /W:1 /XD node_modules .git out dist .turbo build target .context /NFL /NDL /NJH /NJS'
```

`target` is in that list because it is Cargo's output directory for both helper crates, and
it is both large and useless in the guest.

`/R:1 /W:1` is not optional. Robocopy's default is **one million retries thirty seconds
apart**, so a single file held open in the guest hangs the copy for what looks like forever.

Robocopy's exit codes below 8 mean success (1 = files copied, 3 = copied + extras removed);
only >= 8 is a real failure.

This step is incremental: re-running the skill after edits just re-syncs.

### P5. Guest toolchain

`packages/windows-helper` is **Rust + napi-rs**, not node-gyp — so the guest needs a Rust
toolchain and the MSVC linker, and needs no Python at all. The `napi` CLI itself is a
devDependency, so `pnpm install` supplies it.

Check, don't assume:

```sh
"$PRLCTL" exec --current-user <uuid> cmd.exe /c "node -v && pnpm -v && rustc -Vv"
```

Use `--current-user` for this: `rustup` installs per-user, so a SYSTEM shell reports no
`cargo`/`rustc` even on a machine that has them.

`rustc -Vv`'s `host:` line is the answer to a question worth asking early — **a Parallels VM
on an Apple Silicon Mac is Windows on ARM**, so the host triple is `aarch64-pc-windows-msvc`,
not `x86_64`. Both are declared in the package's `napi.targets`, so either builds; just do
not go looking for an x64 binary on an ARM guest.

If something really is missing, propose and wait for a yes:

- Node: `winget install OpenJS.NodeJS.LTS`
- pnpm: `corepack enable && corepack prepare pnpm@10.15.0 --activate` (match `packageManager`)
- Rust: `winget install Rustlang.Rustup`, which installs the MSVC-host toolchain by default
- The linker Cargo needs: `winget install Microsoft.VisualStudio.2022.BuildTools` with the
  **Desktop development with C++** workload. Without it `cargo build` fails at `link.exe`,
  which is the one Rust failure that looks like a Rust problem and is not.

### P6. Install, run, stop

```sh
"$PRLCTL" exec --current-user <uuid> cmd.exe /c "cd /d C:\dev\voxpane && pnpm install --config.confirmModulesPurge=false"
"$PRLCTL" exec --current-user <uuid> cmd.exe /c "cd /d C:\dev\voxpane && pnpm dev > C:\dev\dev.log 2>&1"
```

`--config.confirmModulesPurge=false` answers the "remove and reinstall from scratch?" prompt
that pnpm raises when the guest's `node_modules` predates the current lockfile; without it the
command waits on a keypress nobody can send.

`pnpm dev` is long-running (electron-vite watch) — start it in the background and stream its
output rather than blocking. The Electron window appears on the VM's desktop; bring the VM
window forward so the user can see it.

If the native build fails, it is almost always the missing C++ workload from P5 — report
the Cargo output verbatim instead of retrying blindly.

`prlctl capture <uuid> --file shot.png` grabs the guest screen, but returns black unless the
Parallels window is actually on screen — ask the user to look rather than trusting a black
frame.

To stop the run: `"$PRLCTL" exec <uuid> cmd.exe /c "taskkill /IM electron.exe /F"`. Leave the VM
itself running unless the user asks otherwise.

## SSH path

The remote machine is a real Windows box the user already uses, so the bar is higher than for
a VM: nothing on it changes without a yes, and everything this skill puts there lives under
`C:\dev\` plus one scheduled task, `voxpane-dev`, which S6 removes again.

**Command form.** Every remote command in this path is written for `cmd` and sent as

```sh
ssh <host> 'cmd /c "<cmd line>"'
```

which runs the same whether the remote default shell is `cmd` or PowerShell. Keep the
`<cmd line>` free of inner double quotes — PowerShell 5.1 re-quotes arguments and mangles
them. A command that needs quotes (a path with spaces) goes into a `.cmd` file instead: write
it on the Mac with CRLF line endings, `scp` it to `C:\dev\voxpane-run\`, and run that file.
A single plain command (`tasklist /fi "IMAGENAME eq electron.exe"`) can be sent bare.

### S1. Pick the host

Ask with the user-choice tool:

> Which Windows machine should I connect to over SSH?

Offer, in order: the previously cached host (marked as last used), then `Host` aliases from
`~/.ssh/config`, up to as many options as the tool allows:

```sh
awk 'tolower($1)=="host" { for (i = 2; i <= NF; i++) if ($i !~ /[*?!]/) print $i }' ~/.ssh/config 2>/dev/null
```

That does not follow `Include`, and nothing in it says which hosts are Windows — so the user
**must always be able to type a destination** (`user@192.168.0.20`, or an alias). Claude
Code's question tool has a free-text answer built in; with a tool that has none, add a
"Type a host" option and ask for it in text when it is picked.

Anything beyond `user@host` — a port, a key file, a jump host — belongs in `~/.ssh/config`,
because `scp` has to reach the same machine with the same settings. Offer the `Host` block
and add it only after a yes.

### S2. Reachability and remote shell

Reachability first, non-interactively so a password prompt cannot hang the run:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 <host> 'cmd /c echo ready'
```

Anything but `ready` stops here. Read the error, report it, and say what the user has to do:

- `Permission denied (publickey…)` — key auth is not set up. On Windows OpenSSH a user in the
  **Administrators** group is authenticated against
  `C:\ProgramData\ssh\administrators_authorized_keys`, not `~\.ssh\authorized_keys` — the
  usual reason a key that "is installed" is refused.
- `Host key verification failed` / unknown host — the user connects once with plain
  `ssh <host>` and checks the fingerprint. Never bypass it.
- Timeout or `Connection refused` — OpenSSH Server is not installed or not running on the
  remote (*Settings ▸ Optional features ▸ OpenSSH Server*, then start the `sshd` service).
  That is set up at the machine, not from here.

Then the shell, which also confirms it is Windows at all:

```sh
ssh <host> 'echo %OS%;$env:OS'
```

| Output | Remote default shell |
| --- | --- |
| `Windows_NT;$env:OS` | `cmd` |
| `%OS%`, then `Windows_NT` | PowerShell |
| anything else (`%OS%`, then `:OS`) | a POSIX shell — not Windows, or a `DefaultShell` of bash/WSL. Stop. |

Cache `host`, `shell` and `guestPath` in the `ssh` block of `.context/run-on-windows.json`.

### S3. Mirror the repo onto the remote

There is no shared folder, so the tree has to be copied. The usual reason to run on Windows is
to try the change in front of you, so **copy the working tree, not a commit**: a `git clone`
or `fetch` on the remote would only see what has been pushed. And neither `rsync` nor a
writable share is there by default, while `scp`, `tar` and `robocopy` are part of Windows.

So: pack the tracked and untracked-but-not-ignored files on the Mac, extract them into a
staging directory on the remote, and let robocopy mirror that into the working copy.

```sh
ROOT=$(git rev-parse --show-toplevel)
TARBALL="${TMPDIR:-/tmp}/voxpane-sync.tgz"
(cd "$ROOT" && git ls-files -z -co --exclude-standard \
  | perl -0 -ne 'chomp; print "$_\0" if -e' \
  | COPYFILE_DISABLE=1 tar --null -T - -czf "$TARBALL")
ssh <host> 'cmd /c "if not exist C:\dev\voxpane-run mkdir C:\dev\voxpane-run"'
scp -q "$TARBALL" <host>:C:/dev/voxpane-sync.tgz
ssh <host> 'cmd /c "(if exist C:\dev\voxpane-sync rmdir /s /q C:\dev\voxpane-sync) & mkdir C:\dev\voxpane-sync && tar -xzf C:\dev\voxpane-sync.tgz -C C:\dev\voxpane-sync && robocopy C:\dev\voxpane-sync C:\dev\voxpane /MIR /R:1 /W:1 /XD node_modules .git out dist .turbo target .context /NFL /NDL /NJH /NJS"'
```

Why each piece is there:

- `--exclude-standard` drops everything gitignored — `node_modules`, `target/`, `out/`, the
  generated `.node` and `binding.*` — so nothing platform-specific leaves the Mac.
- The `perl` filter drops paths deleted in the working tree but still in the index; `tar`
  fails on them otherwise. `COPYFILE_DISABLE=1` stops macOS `tar` adding `._*` files.
- The staging directory plus `/MIR` is what carries **deletions** across; extracting straight
  into the working copy would leave removed files behind. The `/XD` list keeps robocopy from
  purging the remote's own `node_modules` and Cargo `target`, so installs and builds stay
  incremental.
- Robocopy's exit code is the command's: below 8 is success, as in P4. `/R:1 /W:1` for the
  same reason as there.
- If the remote's `scp` rejects `C:/dev/…`, it wants `/C:/dev/…`.

### S4. Remote toolchain

Same requirements as P5 — Node, pnpm matching `packageManager`, Rust with the MSVC host
toolchain, and the Build Tools C++ workload — checked the same way:

```sh
ssh <host> 'cmd /c "node -v && pnpm -v && rustc -Vv"'
```

An SSH session runs as the user who logged in, with their profile, so per-user `rustup` is on
`PATH` here without the `--current-user` dance Parallels needs. A physical x64 machine reports
`x86_64-pc-windows-msvc`.

Missing pieces are proposed with the same `winget` commands as P5 and run over SSH only
after a yes. An installer that raises a UAC prompt cannot be answered from here; if one
stalls, ask the user to run it at the machine.

### S5. Install and run in the desktop session

Installing and building need no desktop, so they run over plain SSH — in the background,
since a cold install and native build take minutes:

```sh
ssh <host> 'cmd /c "cd /d C:\dev\voxpane && pnpm install --config.confirmModulesPurge=false"'
```

Running the app does need one. **An OpenSSH session on Windows is not an interactive desktop
session**: what it starts runs in a non-interactive window station (session 0, the services
session), so `pnpm dev` launched straight from `ssh` builds fine and then opens its Electron
window where nobody can see it — and dies with the connection. Start it instead through a
scheduled task with `/it`, which Task Scheduler runs **inside the desktop session of the user
who created it**:

```sh
printf '%s\r\n' '@echo off' 'cd /d C:\dev\voxpane' 'pnpm dev > C:\dev\dev.log 2>&1' > "${TMPDIR:-/tmp}/voxpane-dev.cmd"
scp -q "${TMPDIR:-/tmp}/voxpane-dev.cmd" <host>:C:/dev/voxpane-run/dev.cmd
ssh <host> 'cmd /c "schtasks /create /tn voxpane-dev /tr C:\dev\voxpane-run\dev.cmd /sc once /st 00:00 /it /f && schtasks /run /tn voxpane-dev"'
```

`/sc once /st 00:00` only exists because `schtasks /create` demands a trigger; the task is
started by `/run`, and the past-start-time warning is expected. Registering a task is a change
to the user's machine, so say so before the first one.

That only works if **the SSH user is logged in at the machine's desktop** (console or RDP)
right now — `/it` runs nothing otherwise. Gate on it:

```sh
ssh <host> 'tasklist /v /fi "IMAGENAME eq electron.exe"'
```

The *Session Name* column has to read `Console` or `RDP-Tcp#…`. `Services` means the window is
invisible; no `electron.exe` at all, after a minute, means read the log and
`schtasks /query /tn voxpane-dev /v /fo list` (its *Last Result*), and if the machine sits at
the lock screen or another account is logged in, ask the user to log in as the SSH user.

Stream the log rather than blocking:

```sh
ssh <host> 'powershell -NoProfile -Command "Get-Content C:\dev\dev.log -Wait -Tail 50"'
```

The window appears on that machine's screen, not here — ask the user to look at it.

### S6. Stop

```sh
printf '%s\r\n' '@echo off' \
  "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'cmd.exe' -and \$_.CommandLine -like '*voxpane-run\\dev.cmd*' } | ForEach-Object { taskkill /PID \$_.ProcessId /T /F }\"" \
  'schtasks /delete /tn voxpane-dev /f' > "${TMPDIR:-/tmp}/voxpane-stop.cmd"
scp -q "${TMPDIR:-/tmp}/voxpane-stop.cmd" <host>:C:/dev/voxpane-run/stop.cmd
ssh <host> 'cmd /c C:\dev\voxpane-run\stop.cmd'
```

It kills the **process tree** under the task's `cmd.exe` — turbo, every `node.exe` it spawned,
and Electron — rather than `schtasks /end`, which ends only that `cmd.exe` and orphans the rest,
or `taskkill /IM`, which on someone's own machine would also hit their unrelated `node.exe`
and Electron apps. Then the task is deleted, so nothing of this skill keeps running there.
`C:\dev\` stays for the next sync.

## The bridge script

The overlay reads channels that only the script writes, so a Windows side running an old
script — or none — looks exactly like a broken app, with no error anywhere.

**The app installs the script itself**, on every start: it copies the `overlay-bridge.lua`
bundled in its own resources into SynthV's scripts directory when the bytes differ. So
`pnpm dev` is normally enough. Two Windows-specific catches:

- **Nothing triggers a rescan here.** macOS presses *Scripts ▸ Rescan* through the
  Accessibility API; Windows has no equivalent yet (#78). SynthV only reads its scripts
  directory at startup, so after the app first writes the file, **restart SynthV** — on an
  SSH target, ask the user to, since a SynthV started from SSH would be invisible too.
- **Which directory got it** is the first of these that exists — on a stock guest that has
  been the second:

  1. `%USERPROFILE%\Documents\Dreamtonics\Synthesizer V Studio 2\scripts`
  2. `%APPDATA%\Dreamtonics\Synthesizer V Studio 2\scripts`

  `SYNTHV_SCRIPTS_DIR` overrides both, and Turbo passes that variable through to `dev`.

To iterate on the script without restarting the app, copy it in by hand and restart SynthV.
Parallels:

```sh
"$PRLCTL" exec --current-user <uuid> cmd.exe /c "copy /Y \"C:\\dev\\voxpane\\packages\\synthv-script\\out\\overlay-bridge.lua\" \"%APPDATA%\\Dreamtonics\\Synthesizer V Studio 2\\scripts\\\""
```

SSH — the path has spaces, so it goes through a `.cmd` file:

```sh
printf '%s\r\n' '@echo off' 'copy /Y "C:\dev\voxpane\packages\synthv-script\out\overlay-bridge.lua" "%APPDATA%\Dreamtonics\Synthesizer V Studio 2\scripts"' > "${TMPDIR:-/tmp}/voxpane-copy-script.cmd"
scp -q "${TMPDIR:-/tmp}/voxpane-copy-script.cmd" <host>:C:/dev/voxpane-run/copy-script.cmd
ssh <host> 'cmd /c C:\dev\voxpane-run\copy-script.cmd'
```

Then **confirm what actually loaded** by reading the `Version` row of the *Overlay Bridge*
side panel section — never by reasoning about what you just copied. If no such section
exists, the script is not loaded at all.

## Report

State plainly: which target (the VM, or the SSH host and its shell), the guest path, whether a
sync/install/native build happened, whether the app came up — and over SSH, in which session —
**which script version the side panel showed**, and the stop command. If you stopped at a gate,
say which gate and what the user has to do next.

If the app is up but drawing nothing, that is a debugging job, not a run job — hand over to
[`docs/debugging.md`](../../../docs/debugging.md) rather than guessing.
