// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { LibraryEntry, LogManagerState, RemoteLog, RobotAuth, RobotProfile } from "./shared/LogManager";
import NamedMessage from "./shared/NamedMessage";

type LocalSort = "name" | "robot" | "date" | "duration" | "size" | "format" | "tags";
type RemoteSort = keyof RemoteLog;
interface RemoteState {
  status: "disconnected" | "connecting" | "connected";
  profileId?: string;
  files: RemoteLog[];
  disk?: { total: number; used: number; available: number };
  error?: string;
}
interface Prompt {
  id: string;
  kind: "trust" | "password" | "passphrase" | "rename" | "tags";
  title: string;
  detail: string;
  value?: string;
}

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const profileSelect = element<HTMLSelectElement>("profile");
const authSelect = element<HTMLSelectElement>("auth");
const profileForm = element<HTMLFormElement>("profile-form");
const localBody = document.querySelector<HTMLTableSectionElement>("#local-table tbody")!;
const remoteBody = document.querySelector<HTMLTableSectionElement>("#remote-table tbody")!;
const contextMenu = element<HTMLDivElement>("context-menu");
const promptDialog = element<HTMLDialogElement>("prompt-dialog");
const promptInput = element<HTMLInputElement>("prompt-input");
let messagePort: MessagePort | null = null;
let state: LogManagerState = { profiles: [], folders: [], downloadFolder: "", library: [] };
let remote: RemoteState = { status: "disconnected", files: [] };
let selectedProfileId = "";
let profileDirty = false;
let selectedLocal: string | null = null;
let selectedRemote = new Set<string>();
let localSort: { key: LocalSort; direction: number } = { key: "date", direction: -1 };
let remoteSort: { key: RemoteSort; direction: number } = { key: "modified", direction: -1 };
let busy = false;
let prompt: Prompt | null = null;

function send(name: string, data?: unknown) {
  messagePort?.postMessage({ name, data });
}

function text(id: string, value: string) {
  element(id).textContent = value;
}

function input(id: string) {
  return element<HTMLInputElement>(id);
}

function disabled(id: string, value: boolean) {
  element<HTMLButtonElement>(id).disabled = value;
}

function bytes(value: number) {
  if (value < 1000) return `${value} B`;
  if (value < 1e6) return `${(value / 1000).toFixed(1)} KB`;
  if (value < 1e9) return `${(value / 1e6).toFixed(2)} MB`;
  return `${(value / 1e9).toFixed(2)} GB`;
}

function date(value: number | undefined) {
  return value === undefined
    ? ""
    : new Date(value).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function duration(value: number | undefined) {
  if (value === undefined) return "";
  return value < 60 ? `${value.toFixed(1)} s` : `${Math.floor(value / 60)}m ${(value % 60).toFixed(0)}s`;
}

function readProfile(): RobotProfile {
  let auth: RobotAuth;
  switch (authSelect.value) {
    case "key":
      auth = { kind: "key", keyPath: input("key-path").value };
      break;
    case "password":
      auth = { kind: "password" };
      break;
    case "factory-roborio":
      auth = { kind: "factory", preset: "roborio" };
      break;
    case "factory-systemcore":
      auth = { kind: "factory", preset: "systemcore" };
      break;
    default:
      auth = { kind: "agent" };
  }
  return {
    id: selectedProfileId,
    name: input("profile-name").value.trim(),
    host: input("host").value.trim(),
    port: Number(input("port").value),
    user: input("user").value.trim(),
    remotePath: input("remote-path").value,
    auth
  };
}

function showProfile(profile: RobotProfile) {
  selectedProfileId = profile.id;
  input("profile-name").value = profile.name;
  input("host").value = profile.host;
  input("port").value = String(profile.port);
  input("user").value = profile.user;
  input("remote-path").value = profile.remotePath;
  authSelect.value = profile.auth.kind === "factory" ? `factory-${profile.auth.preset}` : profile.auth.kind;
  input("key-path").value = profile.auth.kind === "key" ? profile.auth.keyPath : "";
  element("key-setting").hidden = profile.auth.kind !== "key";
  profileDirty = false;
}

function renderProfiles() {
  profileSelect.replaceChildren();
  state.profiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    profileSelect.append(option);
  });
  if (selectedProfileId && !state.profiles.some((profile) => profile.id === selectedProfileId)) {
    const option = document.createElement("option");
    option.value = selectedProfileId;
    option.textContent = "New Linux robot";
    profileSelect.append(option);
  }
  const newOption = document.createElement("option");
  newOption.value = "__new";
  newOption.textContent = "New profile...";
  profileSelect.append(newOption);
  if (!selectedProfileId && state.profiles.length) showProfile(state.profiles[0]);
  if (!profileDirty) {
    const profile = state.profiles.find((entry) => entry.id === selectedProfileId);
    if (profile) showProfile(profile);
  }
  profileSelect.value = selectedProfileId;
}

function renderFolders() {
  const folders = element("folders");
  folders.replaceChildren();
  state.folders.forEach((folder) => {
    const row = document.createElement("div");
    const label = document.createElement("span");
    label.className = "path";
    label.textContent = folder;
    label.title = folder;
    row.append(label);
    if (folder !== state.downloadFolder) {
      const button = document.createElement("button");
      button.textContent = "Remove";
      button.title = "Remove this folder from the library. Files stay on disk.";
      button.addEventListener("click", () => send("remove-folder", folder));
      row.append(button);
    }
    folders.append(row);
  });
  text("download-folder", state.downloadFolder);
  element("download-folder").title = state.downloadFolder;
}

function cell(row: HTMLTableRowElement, value: string) {
  const result = row.insertCell();
  result.textContent = value;
  result.title = value;
  return result;
}

function badge(parent: HTMLElement, value: string) {
  const span = document.createElement("span");
  span.className = "badge";
  span.textContent = value;
  parent.append(span);
}

function compare(a: string | number, b: string | number) {
  return typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b), undefined, { numeric: true });
}

function localValue(entry: LibraryEntry, key: LocalSort) {
  if (key === "date") return entry.date ?? entry.mtime;
  if (key === "tags") return entry.tags.join(", ");
  return entry[key] ?? "";
}

function localActions(entry: LibraryEntry) {
  return [
    { title: "Open in TerraScope", command: "open", enabled: !entry.missing },
    { title: "Reveal in file manager", command: "reveal", enabled: !entry.missing },
    { title: "Rename...", command: "rename", enabled: !entry.readOnly && !entry.missing },
    { title: "Edit tags...", command: "tags", enabled: !entry.readOnly && !entry.missing },
    { title: "Move to Trash...", command: "trash", enabled: !entry.readOnly && !entry.missing },
    { title: "Remove from list", command: "remove-missing", enabled: !entry.readOnly && entry.missing }
  ];
}

function showContext(event: MouseEvent, actions: { title: string; enabled: boolean; run: () => void }[]) {
  event.preventDefault();
  contextMenu.replaceChildren();
  actions.forEach((action) => {
    const button = document.createElement("button");
    button.setAttribute("role", "menuitem");
    button.textContent = action.title;
    button.disabled = !action.enabled;
    button.addEventListener("click", () => {
      contextMenu.hidden = true;
      action.run();
    });
    contextMenu.append(button);
  });
  contextMenu.hidden = false;
  contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - contextMenu.offsetWidth - 8)}px`;
  contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - contextMenu.offsetHeight - 8)}px`;
  contextMenu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

function renderLocal() {
  const search = input("local-search").value.toLocaleLowerCase();
  const entries = state.library
    .filter((entry) =>
      [entry.name, entry.robot ?? "", ...entry.tags].some((value) => value.toLocaleLowerCase().includes(search))
    )
    .sort(
      (a, b) =>
        Number(b.readOnly) - Number(a.readOnly) ||
        localSort.direction * compare(localValue(a, localSort.key), localValue(b, localSort.key))
    );
  localBody.replaceChildren();
  entries.forEach((entry) => {
    const row = localBody.insertRow();
    row.tabIndex = 0;
    row.classList.toggle("selected", selectedLocal === entry.path);
    row.classList.toggle("missing", entry.missing);
    row.setAttribute("aria-selected", String(selectedLocal === entry.path));
    row.title = entry.error ? `${entry.path}\n${entry.error}` : entry.path;
    row.dataset.path = entry.path;
    const name = cell(row, entry.name);
    if (entry.readOnly) badge(name, "Read-only sample");
    if (entry.missing) badge(name, "Missing");
    cell(row, entry.robot ?? "");
    cell(row, date(entry.date ?? (entry.missing ? undefined : entry.mtime)));
    cell(row, duration(entry.duration));
    cell(row, entry.missing ? "" : bytes(entry.size));
    cell(row, entry.format);
    cell(row, entry.tags.join(", "));
    row.addEventListener("click", () => {
      selectedLocal = entry.path;
      updateLocalSelection();
    });
    row.addEventListener("dblclick", () => {
      if (!entry.missing) send("open", entry.path);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !entry.missing) send("open", entry.path);
      if (event.key === " ") {
        event.preventDefault();
        selectedLocal = entry.path;
        updateLocalSelection();
        localBody.querySelector<HTMLTableRowElement>("tr.selected")?.focus();
      }
    });
    row.addEventListener("contextmenu", (event) => {
      selectedLocal = entry.path;
      updateLocalSelection();
      showContext(
        event,
        localActions(entry)
          .filter((action) => action.command !== "remove-missing" || entry.missing)
          .map((action) => ({
            title: action.title,
            enabled: action.enabled,
            run: () => send(action.command, entry.path)
          }))
      );
    });
  });
  element("local-empty").hidden = entries.length > 0;
  text("library-count", `${state.library.length} ${state.library.length === 1 ? "log" : "logs"}`);
  updateLocalSelection();
  document.querySelectorAll<HTMLTableCellElement>("#local-table th").forEach((header) => {
    const button = header.querySelector<HTMLButtonElement>("button")!;
    header.setAttribute(
      "aria-sort",
      button.dataset.localSort === localSort.key ? (localSort.direction > 0 ? "ascending" : "descending") : "none"
    );
  });
}

function updateLocalSelection() {
  localBody.querySelectorAll<HTMLTableRowElement>("tr").forEach((row) => {
    const selected = row.dataset.path === selectedLocal;
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-selected", String(selected));
  });
  const entry = state.library.find((item) => item.path === selectedLocal);
  ["open", "reveal", "rename", "tags", "trash"].forEach((command) =>
    disabled(command, !entry || !localActions(entry).find((action) => action.command === command)?.enabled)
  );
  element("remove-missing").hidden = !entry?.missing || entry.readOnly;
  text("selected-path", entry?.path ?? "Choose a log to open it in TerraScope.");
  element("selected-path").title = entry?.path ?? "";
}

function visibleRemote() {
  const search = input("remote-search").value.toLocaleLowerCase();
  return remote.files
    .filter((file) => file.name.toLocaleLowerCase().includes(search))
    .sort((a, b) => remoteSort.direction * compare(a[remoteSort.key], b[remoteSort.key]));
}

function updateControls() {
  disabled("connect", busy || remote.status !== "disconnected");
  disabled("disconnect", remote.status === "disconnected");
  disabled("save-profile", busy);
  disabled("refresh-remote", busy || remote.status !== "connected");
  disabled("sync-selected", busy || remote.status !== "connected" || selectedRemote.size === 0);
  disabled("sync-all", busy || remote.status !== "connected" || remote.files.length === 0);
  disabled("cancel", !busy);
}

function renderRemote() {
  remoteBody.replaceChildren();
  const files = visibleRemote();
  files.forEach((file) => {
    const row = remoteBody.insertRow();
    row.classList.toggle("selected", selectedRemote.has(file.name));
    const checkCell = row.insertCell();
    checkCell.className = "check-column";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedRemote.has(file.name);
    checkbox.setAttribute("aria-label", `Select ${file.name}`);
    checkbox.addEventListener("change", () => {
      checkbox.checked ? selectedRemote.add(file.name) : selectedRemote.delete(file.name);
      renderRemote();
      const next = Array.from(remoteBody.querySelectorAll<HTMLInputElement>("input")).find(
        (item) => item.getAttribute("aria-label") === `Select ${file.name}`
      );
      next?.focus();
    });
    checkCell.append(checkbox);
    cell(row, file.name);
    cell(row, bytes(file.size));
    cell(row, date(file.modified));
    row.addEventListener("contextmenu", (event) => {
      if (!selectedRemote.has(file.name)) selectedRemote = new Set([file.name]);
      renderRemote();
      showContext(event, [
        {
          title: "Sync selected",
          enabled: !busy && remote.status === "connected",
          run: () => send("sync", { names: [...selectedRemote] })
        }
      ]);
    });
  });
  const all = input("select-all-remote");
  all.checked = files.length > 0 && files.every((file) => selectedRemote.has(file.name));
  all.indeterminate = !all.checked && files.some((file) => selectedRemote.has(file.name));
  all.disabled = files.length === 0;
  text(
    "connection-status",
    remote.status === "connected" ? "Connected" : remote.status === "connecting" ? "Connecting..." : "Disconnected"
  );
  element("connection-status").dataset.status = remote.status;
  text("disk-usage", remote.disk ? `${bytes(remote.disk.available)} free of ${bytes(remote.disk.total)}` : "");
  element("disk-usage").title = remote.disk ? `${bytes(remote.disk.used)} used in the remote filesystem` : "";
  element("remote-empty").hidden = files.length > 0;
  text(
    "remote-empty",
    remote.error ??
      (remote.status === "connected"
        ? remote.files.length
          ? "No logs match your search."
          : "No supported log files in this directory."
        : remote.status === "connecting"
        ? "Connecting securely to the robot..."
        : "Connect to a robot to browse logs. Downloads start only when you choose Sync.")
  );
  document.querySelectorAll<HTMLTableCellElement>("#remote-table th").forEach((header) => {
    const button = header.querySelector<HTMLButtonElement>("button");
    if (button)
      header.setAttribute(
        "aria-sort",
        button.dataset.remoteSort === remoteSort.key ? (remoteSort.direction > 0 ? "ascending" : "descending") : "none"
      );
  });
  updateControls();
}

function showPrompt(value: Prompt) {
  if (prompt) finishPrompt(null);
  prompt = value;
  promptDialog.dataset.kind = value.kind;
  text("prompt-title", value.title);
  text("prompt-detail", value.detail);
  const secret = value.kind === "password" || value.kind === "passphrase";
  promptInput.type = secret ? "password" : "text";
  promptInput.value = secret ? "" : value.value ?? "";
  element("prompt-input-label").hidden = value.kind === "trust";
  text(
    "prompt-input-caption",
    value.kind === "passphrase"
      ? "Key passphrase"
      : value.kind === "password"
      ? "Password"
      : value.kind === "tags"
      ? "Tags, separated by commas"
      : "File name"
  );
  text(
    "prompt-confirm",
    value.kind === "trust"
      ? "Trust this host key"
      : value.kind === "rename"
      ? "Rename"
      : value.kind === "tags"
      ? "Save tags"
      : "Connect"
  );
  promptDialog.showModal();
  if (value.kind === "trust") element("prompt-cancel").focus();
  else {
    promptInput.focus();
    promptInput.select();
  }
}

function finishPrompt(value: string | null) {
  if (!prompt) return;
  const id = prompt.id;
  prompt = null;
  promptInput.value = "";
  promptDialog.close();
  send("prompt-response", { id, value });
}

function handleMessage(message: NamedMessage) {
  switch (message.name) {
    case "state":
      state = message.data as LogManagerState;
      renderProfiles();
      renderFolders();
      renderLocal();
      break;
    case "remote":
      remote = message.data as RemoteState;
      selectedRemote = new Set([...selectedRemote].filter((name) => remote.files.some((file) => file.name === name)));
      renderRemote();
      break;
    case "busy":
      busy = message.data as boolean;
      updateControls();
      break;
    case "activity": {
      const activity = element("activity");
      const row = document.createElement("div");
      const time = document.createElement("time");
      time.textContent = new Date().toLocaleTimeString();
      row.append(time, document.createTextNode(message.data.text));
      row.classList.toggle("error", !!message.data.error);
      activity.append(row);
      while (activity.children.length > 300) activity.firstElementChild?.remove();
      activity.scrollTop = activity.scrollHeight;
      if (typeof message.data.progress === "number") {
        const progress = element<HTMLProgressElement>("sync-progress");
        progress.hidden = false;
        progress.value = message.data.progress;
      }
      break;
    }
    case "prompt":
      showPrompt(message.data as Prompt);
      break;
    case "key-path":
      input("key-path").value = message.data as string;
      profileDirty = true;
      break;
    case "set-focused":
      document.querySelectorAll("button").forEach((button) => button.classList.toggle("blurred", !message.data));
      break;
  }
}

window.addEventListener("message", (event) => {
  if (event.data !== "port" || !event.ports[0]) return;
  messagePort?.close();
  messagePort = event.ports[0];
  messagePort.onmessage = (event) => handleMessage(event.data as NamedMessage);
  send("ready");
});

profileSelect.addEventListener("change", () => {
  if (profileSelect.value === "__new") {
    showProfile({
      id: crypto.randomUUID(),
      name: "Linux robot",
      host: "",
      port: 22,
      user: "",
      remotePath: "",
      auth: { kind: "agent" }
    });
    profileDirty = true;
    renderProfiles();
    element<HTMLDetailsElement>("settings").open = true;
    input("profile-name").focus();
  } else {
    const profile = state.profiles.find((item) => item.id === profileSelect.value);
    if (profile) showProfile(profile);
  }
});
profileForm.addEventListener("input", () => {
  profileDirty = true;
});
authSelect.addEventListener("change", () => {
  element("key-setting").hidden = authSelect.value !== "key";
  profileDirty = true;
});
element("save-profile").addEventListener("click", () => {
  const profile = readProfile();
  if (!profile.name) {
    input("profile-name").focus();
    return;
  }
  profileDirty = false;
  send("save-profile", profile);
});
profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  send("connect", readProfile());
});
[
  "disconnect",
  "refresh-local",
  "refresh-remote",
  "choose-download-folder",
  "add-folder",
  "choose-key",
  "cancel"
].forEach((command) => element(command).addEventListener("click", () => send(command)));
["open", "reveal", "rename", "tags", "trash", "remove-missing"].forEach((command) =>
  element(command).addEventListener("click", () => {
    if (selectedLocal) send(command, selectedLocal);
  })
);
element("sync-selected").addEventListener("click", () => send("sync", { names: [...selectedRemote] }));
element("sync-all").addEventListener("click", () => send("sync", { names: null }));
input("select-all-remote").addEventListener("change", () => {
  const select = input("select-all-remote").checked;
  visibleRemote().forEach((file) => (select ? selectedRemote.add(file.name) : selectedRemote.delete(file.name)));
  renderRemote();
});
input("local-search").addEventListener("input", renderLocal);
input("remote-search").addEventListener("input", renderRemote);
document.querySelectorAll<HTMLButtonElement>("[data-local-sort]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.localSort as LocalSort;
    localSort = { key, direction: localSort.key === key ? -localSort.direction : 1 };
    renderLocal();
  })
);
document.querySelectorAll<HTMLButtonElement>("[data-remote-sort]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.remoteSort as RemoteSort;
    remoteSort = { key, direction: remoteSort.key === key ? -remoteSort.direction : 1 };
    renderRemote();
  })
);
element("prompt-cancel").addEventListener("click", () => finishPrompt(null));
element("prompt-confirm").addEventListener("click", () =>
  finishPrompt(prompt?.kind === "trust" ? "trust" : promptInput.value)
);
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    finishPrompt(promptInput.value);
  }
});
promptDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  finishPrompt(null);
});
document.addEventListener("pointerdown", (event) => {
  if (!contextMenu.contains(event.target as Node)) contextMenu.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") contextMenu.hidden = true;
});
renderLocal();
renderRemote();
