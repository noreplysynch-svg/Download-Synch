(function () {
  "use strict";

  const APP_NAMES = {
    downloader: "Synch Video Downloader",
    vpn: "Synch VPN",
    message: "Synch Message"
  };

  /* ---------- Theme ---------- */
  const THEMES = ["dark", "light", "system"];
  const ICONS = {
    dark: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.9 4.9l1.4 1.4"/><path d="M17.7 17.7l1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.9 19.1l1.4-1.4"/><path d="M17.7 6.3l1.4-1.4"/>',
    light: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>'
  };

  const root = document.documentElement;
  const themeToggle = document.getElementById("themeToggle");
  const themeIcon = document.getElementById("themeIcon");

  function applyTheme(mode) {
    if (mode === "system") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.setAttribute("data-theme", prefersDark ? "dark" : "light");
    } else {
      root.setAttribute("data-theme", mode);
    }
    themeIcon.innerHTML = ICONS[mode];
    localStorage.setItem("synch-theme-pref", mode);
  }
  function currentPref() {
    return localStorage.getItem("synch-theme-pref") || "dark";
  }
  applyTheme(currentPref());

  themeToggle.addEventListener("click", () => {
    const next = THEMES[(THEMES.indexOf(currentPref()) + 1) % THEMES.length];
    applyTheme(next);
    showToast(next === "system" ? "Following system theme" : `${next[0].toUpperCase()}${next.slice(1)} theme`);
  });

  /* ---------- Screen switching ---------- */
  const screens = document.querySelectorAll(".screen");
  const dockButtons = document.querySelectorAll(".dock-btn");
  function showScreen(id) {
    screens.forEach((s) => s.classList.toggle("is-active", s.id === id));
    dockButtons.forEach((b) => b.classList.toggle("is-active", b.dataset.target === id));
  }

  /* ---------- PIN gate (admin session only) ---------- */
  const pinModal = document.getElementById("pinModal");
  const pinModalInput = document.getElementById("pinModalInput");
  const pinError = document.getElementById("pinError");
  const pinCancelBtn = document.getElementById("pinCancelBtn");
  const pinSubmitBtn = document.getElementById("pinSubmitBtn");

  function getPin() {
    return sessionStorage.getItem("synch-owner-pin") || "";
  }

  function openPinModal() {
    pinError.hidden = true;
    pinModalInput.value = "";
    pinModal.hidden = false;
    pinModalInput.focus();
  }
  function closePinModal() {
    pinModal.hidden = true;
  }

  async function submitPin() {
    const pin = pinModalInput.value.trim();
    if (!pin) return;
    pinSubmitBtn.disabled = true;
    try {
      const res = await fetch("/api/verify-pin", {
        method: "POST",
        headers: { "x-owner-pin": pin }
      });
      if (!res.ok) {
        pinError.hidden = false;
        pinModalInput.value = "";
        pinModalInput.focus();
        return;
      }
      // Correct PIN: remember for this browser tab session only, unlock the tab.
      sessionStorage.setItem("synch-owner-pin", pin);
      closePinModal();
      showScreen("uploadScreen");
      refreshUI();
    } catch {
      showToast("Couldn't reach the server");
    } finally {
      pinSubmitBtn.disabled = false;
    }
  }

  pinSubmitBtn.addEventListener("click", submitPin);
  pinModalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPin();
  });
  pinCancelBtn.addEventListener("click", () => {
    closePinModal();
    // Cancelling shouldn't strand the user on a screen they can't see; go home.
    showScreen("homeScreen");
  });

  dockButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      if (target === "uploadScreen" && !getPin()) {
        openPinModal();
        return;
      }
      showScreen(target);
    });
  });

  /* ---------- Helpers ---------- */
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  function formatDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  /* ---------- Load state from server & render ---------- */
  async function refreshUI() {
    let data = {};
    try {
      const res = await fetch("/api/apps");
      data = await res.json();
    } catch {
      showToast("Couldn't reach the server");
      return;
    }

    document.querySelectorAll(".app-card").forEach((card) => {
      const id = card.dataset.appId;
      const btn = card.querySelector(".open-btn");
      const meta = card.querySelector(".app-meta");
      const record = data[id];
      if (record) {
        btn.classList.remove("is-disabled");
        btn.href = `/api/apps/${id}/download`;
        meta.textContent = `${formatSize(record.size)} · ${formatDate(record.uploadedAt)}`;
      } else {
        btn.classList.add("is-disabled");
        btn.removeAttribute("href");
        meta.textContent = "Not available yet";
      }
    });

    document.querySelectorAll(".upload-card").forEach((card) => {
      const id = card.dataset.appId;
      const status = card.querySelector(".upload-status");
      const removeBtn = card.querySelector(".upload-remove");
      const record = data[id];
      if (record) {
        card.classList.add("has-file");
        status.textContent = `${record.fileName} · ${formatSize(record.size)}`;
        removeBtn.hidden = false;
      } else {
        card.classList.remove("has-file");
        status.textContent = "No file uploaded";
        removeBtn.hidden = true;
      }
    });
  }

  /* ---------- Upload / remove (admin) ---------- */
  async function uploadFile(appId, file) {
    if (!file.name.toLowerCase().endsWith(".apk")) {
      showToast("Only .apk files are supported");
      return;
    }
    const pin = getPin();
    if (!pin) {
      showToast("Enter your owner PIN first");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    showToast(`Uploading ${file.name}…`);
    try {
      const res = await fetch(`/api/apps/${appId}`, {
        method: "POST",
        headers: { "x-owner-pin": pin },
        body: formData
      });
      const body = await res.json();
      if (!res.ok) {
        if (res.status === 401) handlePinRejected();
        throw new Error(body.error || "Upload failed");
      }
      showToast(`${APP_NAMES[appId]} updated`);
      refreshUI();
    } catch (err) {
      showToast(err.message);
    }
  }

  function handlePinRejected() {
    sessionStorage.removeItem("synch-owner-pin");
    showScreen("homeScreen");
  }

  async function removeFile(appId) {
    const pin = getPin();
    if (!pin) {
      showToast("Enter your owner PIN first");
      return;
    }
    try {
      const res = await fetch(`/api/apps/${appId}`, {
        method: "DELETE",
        headers: { "x-owner-pin": pin }
      });
      const body = await res.json();
      if (!res.ok) {
        if (res.status === 401) handlePinRejected();
        throw new Error(body.error || "Remove failed");
      }
      showToast(`${APP_NAMES[appId]} removed`);
      refreshUI();
    } catch (err) {
      showToast(err.message);
    }
  }

  document.querySelectorAll(".upload-card").forEach((card) => {
    const appId = card.dataset.appId;
    const input = card.querySelector('input[type="file"]');
    const removeBtn = card.querySelector(".upload-remove");

    input.addEventListener("change", (e) => {
      if (e.target.files.length) uploadFile(appId, e.target.files[0]);
      input.value = "";
    });

    ["dragenter", "dragover"].forEach((evt) =>
      card.addEventListener(evt, (e) => {
        e.preventDefault();
        card.classList.add("is-drag");
      })
    );
    ["dragleave", "drop"].forEach((evt) =>
      card.addEventListener(evt, (e) => {
        e.preventDefault();
        card.classList.remove("is-drag");
      })
    );
    card.addEventListener("drop", (e) => {
      if (e.dataTransfer.files.length) uploadFile(appId, e.dataTransfer.files[0]);
    });

    removeBtn.addEventListener("click", () => removeFile(appId));
  });

  refreshUI();

  /* ---------- Toast ---------- */
  const toast = document.getElementById("toast");
  let toastTimer;
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2200);
  }
})();
