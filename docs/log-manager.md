# Manage robot logs

Open **File > Log Manager...** with **Ctrl+Shift+D** on Linux and Windows, or **Cmd+Shift+D** on macOS.

To explore without a robot, select **TerraScope sample robot** in the local library and click **Open**. The bundled MCAP contains 40 seconds of a driving loop, a ramp pose, IMU values, motor currents and voltages, boolean states, an array, and text messages. The sample has a read-only badge. Its pose fields work in the existing 2D and 3D field tabs.

## Pull logs from a Linux robot

1. Select a preset or create a profile. Enter its host, SSH port, user, and absolute remote log directory.
2. Select an authentication method. Use your system SSH agent, a private key file, or a password for this window's session. Factory credential options reproduce the existing roboRIO and SystemCore defaults.
3. Click **Save profile**, then **Connect**. Verify the displayed SHA256 host-key fingerprint with the robot administrator before clicking **Trust host key**. A changed key refuses the connection and shows both fingerprints.
4. Select remote logs and click **Sync selected**, or click **Sync all**. The remote list contains supported log formats. Search and column headings filter and sort the list.

Downloads go into **Documents/TerraScope Logs** by default. **Choose folder...** changes the download location. A matching local name and size skips a transfer. A different-size collision reports an error and keeps the local file. Each transfer writes a temporary file in the destination folder, checks its size, and publishes the complete file without replacing an existing destination. Cancellation removes the unfinished temporary file. Completed downloads remain usable.

The remote pane provides read-only access. Sync starts only after your action. The window polls the directory's disk usage about every five seconds while connected. Disk errors and transfer errors appear in Activity. There are no remote deletion actions.

Profiles and TerraScope's `known_hosts` file live under Electron's userData directory. Passwords and key passphrases stay in memory until the window closes. They are absent from the profile file and library index. On Windows, agent authentication tries the OpenSSH agent pipe and then Pageant. On macOS and Linux it uses `SSH_AUTH_SOCK`.

## Organize local logs

The library includes configured folders and logs opened elsewhere in TerraScope. Add a library folder to discover its supported files. Removing a folder stops scanning it and retains its indexed entries and files.

Search names, robot names, and tags. Click any column heading to sort. Use the toolbar or a row's context menu to open, reveal, rename, edit tags, or move a file to the system trash. Trash requires confirmation. Renames refuse collisions and retain tags. The built-in sample refuses rename, trash, and tag edits.

Missing files stay in the list with a **Missing** badge. **Remove from list** removes only that missing entry. Restore the file and refresh to use it again.

MCAP duration comes from summary statistics. Robot names and wall-clock start times come from Metadata records when present. A downloaded profile supplies the robot name when file metadata does not. WPILOG metadata uses a bounded scan. Other formats and large WPILOG files may leave duration blank. Metadata extraction runs in a worker and caches results by path, size, and modification time.

Rename and download publication use exclusive hard links within the destination directory, followed by removal of the old name. This prevents an overwrite if another program creates the destination at the same moment. Filesystems without hard-link support report an error and leave the existing files intact.
