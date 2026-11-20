// ==============================
// FocusRoom - Supabase Client (Step 4)
// ==============================

// Keep project settings together so they are easy to update.
const SUPABASE_CONFIG = {
    url: "https://jwyrkiojdzfxabsrgack.supabase.co",
    publishableKey: "sb_publishable_DUgAecbESNQ6OTIhCM7Qqw_k-Dhpidf"
};

let supabaseClient = null;

function initializeSupabase() {
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
        console.error(
            "[FocusRoom] Supabase SDK failed to load. Check your internet connection or CDN availability."
        );
        return null;
    }

    try {
        const { createClient } = window.supabase;
        supabaseClient = createClient(
            SUPABASE_CONFIG.url,
            SUPABASE_CONFIG.publishableKey
        );
        console.info("[FocusRoom] Supabase client initialized.");
        return supabaseClient;
    } catch (error) {
        console.error("[FocusRoom] Supabase client initialization failed:", error);
        return null;
    }
}

async function checkSupabaseAuthHealth() {
    if (!supabaseClient) {
        console.warn("[FocusRoom] Auth health check skipped: Supabase client is unavailable.");
        return;
    }

    const healthUrl = `${SUPABASE_CONFIG.url}/auth/v1/health`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(healthUrl, {
            method: "GET",
            headers: {
                apikey: SUPABASE_CONFIG.publishableKey
            },
            signal: controller.signal
        });

        if (!response.ok) {
            const responseText = await response.text().catch(() => "");
            console.error(
                `[FocusRoom] Supabase Auth health check failed (HTTP ${response.status}).`,
                responseText
            );
            return;
        }

        const healthData = await response.json();
        console.info("[FocusRoom] Supabase Auth is reachable.", healthData);
    } catch (error) {
        if (error.name === "AbortError") {
            console.error("[FocusRoom] Supabase Auth health check timed out after 10 seconds.");
        } else {
            console.error(
                "[FocusRoom] Could not reach Supabase Auth. Check your network and project URL.",
                error
            );
        }
    } finally {
        clearTimeout(timeoutId);
    }
}

initializeSupabase();
checkSupabaseAuthHealth();

// ==============================
// FocusRoom - Global Realtime Presence (Step 5)
// ==============================

const SESSION_NAME_KEY = "focusRoomTemporaryName";
const SESSION_ID_KEY = "focusRoomPresenceSessionId";
const GLOBAL_CHANNEL_NAME = "focusroom-global";

const welcomeScreen = document.getElementById("welcome-screen");
const dashboard = document.getElementById("app-dashboard");
const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("temporary-name");
const nameError = document.getElementById("name-error");
const userList = document.getElementById("user-list");
const onlineCount = document.getElementById("online-count");

let presenceChannel = null;
let presenceSessionId = null;
let currentDisplayName = null;
let isPresenceTracked = false;
let isStartingPresence = false;
let isCleaningUpPresence = false;

function createUniqueSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
    }

    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
        const values = new Uint8Array(16);
        window.crypto.getRandomValues(values);
        return Array.from(values, value => value.toString(16).padStart(2, "0")).join("");
    }

    return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getOrCreateSessionId() {
    let savedId = sessionStorage.getItem(SESSION_ID_KEY);

    if (!savedId) {
        savedId = createUniqueSessionId();
        sessionStorage.setItem(SESSION_ID_KEY, savedId);
    }

    return savedId;
}

function getInitials(name) {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part.charAt(0).toUpperCase())
        .join("");
}

function createUserItem(user, isCurrentUser = false) {
    const userItem = document.createElement("div");
    userItem.className = "user-item";

    const avatar = document.createElement("div");
    avatar.className = "user-avatar";
    avatar.textContent = getInitials(user.displayName);

    const name = document.createElement("div");
    name.className = "user-name";
    name.textContent = user.displayName;

    if (isCurrentUser) {
        const youLabel = document.createElement("span");
        youLabel.className = "you-label";
        youLabel.textContent = " (You)";
        name.appendChild(youLabel);
    }

    const status = document.createElement("span");
    status.className = "user-status";
    status.setAttribute("aria-label", "Online");

    userItem.append(avatar, name, status);
    return userItem;
}

// Presence state is keyed by Presence key and each key can contain
// one or more metadata entries. Session IDs, not display names, identify users.
function getOnlineSessions() {
    if (!presenceChannel) {
        return [];
    }

    const state = presenceChannel.presenceState();
    const sessionsById = new Map();

    Object.entries(state).forEach(([presenceKey, metadataList]) => {
        const entries = Array.isArray(metadataList) ? metadataList : [];

        entries.forEach(metadata => {
            if (!metadata || !metadata.sessionId || !metadata.displayName) {
                return;
            }

            if (!sessionsById.has(metadata.sessionId)) {
                sessionsById.set(metadata.sessionId, {
                    sessionId: metadata.sessionId,
                    displayName: metadata.displayName,
                    onlineAt: metadata.onlineAt || "",
                    presenceKey
                });
            }
        });
    });

    return Array.from(sessionsById.values()).sort((a, b) => {
        return a.onlineAt.localeCompare(b.onlineAt);
    });
}

function renderOnlineUsers() {
    const onlineSessions = getOnlineSessions();

    userList.replaceChildren();
    onlineCount.textContent = `${onlineSessions.length} Online`;

    onlineSessions.forEach(session => {
        userList.appendChild(
            createUserItem(
                session,
                session.sessionId === presenceSessionId
            )
        );
    });
}

function handlePresenceSync() {
    if (!presenceChannel) return;

    console.info("[FocusRoom] Presence synced.");
    renderOnlineUsers();
}

function handlePresenceJoin(payload) {
    console.info("[FocusRoom] Presence join event:", payload);
    renderOnlineUsers();
}

function handlePresenceLeave(payload) {
    console.info("[FocusRoom] Presence leave event:", payload);
    renderOnlineUsers();
}

async function trackCurrentSession(channel) {
    if (isPresenceTracked || channel !== presenceChannel || !currentDisplayName) {
        return;
    }

    const presencePayload = {
        sessionId: presenceSessionId,
        displayName: currentDisplayName,
        onlineAt: new Date().toISOString()
    };

    try {
        const result = await channel.track(presencePayload);

        if (result && result.error) {
            console.error("[FocusRoom] Presence tracking failed:", result.error);
            return;
        }

        isPresenceTracked = true;
        console.info("[FocusRoom] Current session is now tracked in global Presence.");
        renderOnlineUsers();
    } catch (error) {
        console.error("[FocusRoom] Could not track current session:", error);
    }
}

function startGlobalPresence() {
    if (!supabaseClient) {
        console.error("[FocusRoom] Cannot join global Presence: Supabase client is unavailable.");
        onlineCount.textContent = "0 Online";
        return;
    }

    if (!currentDisplayName || presenceChannel || isStartingPresence || isCleaningUpPresence) {
        return;
    }

    isStartingPresence = true;
    presenceSessionId = getOrCreateSessionId();

    const channel = supabaseClient.channel(GLOBAL_CHANNEL_NAME, {
        config: {
            presence: {
                key: presenceSessionId
            }
        }
    });

    presenceChannel = channel;
    isPresenceTracked = false;

    channel
        .on("presence", { event: "sync" }, handlePresenceSync)
        .on("presence", { event: "join" }, handlePresenceJoin)
        .on("presence", { event: "leave" }, handlePresenceLeave)
        .subscribe(async status => {
            console.info("[FocusRoom] Global Presence channel status:", status);

            if (channel !== presenceChannel) {
                return;
            }

            if (status === "SUBSCRIBED") {
                isStartingPresence = false;
                await trackCurrentSession(channel);
                renderOnlineUsers();
                return;
            }

            if (
                status === "CHANNEL_ERROR" ||
                status === "TIMED_OUT" ||
                status === "CLOSED"
            ) {
                isPresenceTracked = false;
                isStartingPresence = false;
                console.warn(
                    "[FocusRoom] Presence connection interrupted. Supabase will attempt to reconnect."
                );
            }
        });
}

async function cleanupGlobalPresence() {
    if (!presenceChannel || isCleaningUpPresence || !supabaseClient) {
        return;
    }

    isCleaningUpPresence = true;

    const channelToRemove = presenceChannel;
    presenceChannel = null;
    isPresenceTracked = false;
    isStartingPresence = false;

    try {
        await supabaseClient.removeChannel(channelToRemove);
        console.info("[FocusRoom] Global Presence channel cleaned up.");
    } catch (error) {
        console.warn(
            "[FocusRoom] Channel cleanup did not finish; Supabase will expire presence after disconnect.",
            error
        );
    } finally {
        isCleaningUpPresence = false;
    }
}

function showDashboard(name) {
    currentDisplayName = name;
    welcomeScreen.hidden = true;
    dashboard.hidden = false;
    startGlobalPresence();
}

function showWelcome() {
    currentDisplayName = null;
    dashboard.hidden = true;
    welcomeScreen.hidden = false;
    userList.replaceChildren();
    onlineCount.textContent = "0 Online";
}

function validateName(rawName) {
    const trimmedName = rawName.trim();

    if (!trimmedName) {
        return {
            valid: false,
            message: "Please enter a name before joining."
        };
    }

    if (trimmedName.length > 20) {
        return {
            valid: false,
            message: "Your name must be 20 characters or fewer."
        };
    }

    return { valid: true, name: trimmedName };
}

joinForm.addEventListener("submit", event => {
    event.preventDefault();

    const result = validateName(nameInput.value);

    if (!result.valid) {
        nameError.textContent = result.message;
        nameInput.setAttribute("aria-invalid", "true");
        nameInput.focus();
        return;
    }

    nameError.textContent = "";
    nameInput.removeAttribute("aria-invalid");

    sessionStorage.setItem(SESSION_NAME_KEY, result.name);
    showDashboard(result.name);
});

nameInput.addEventListener("input", () => {
    nameError.textContent = "";
    nameInput.removeAttribute("aria-invalid");
});

// Restore the temporary name and rejoin Presence after a refresh in this tab.
const savedName = sessionStorage.getItem(SESSION_NAME_KEY);

if (savedName && savedName.trim() && savedName.trim().length <= 20) {
    showDashboard(savedName.trim());
} else {
    sessionStorage.removeItem(SESSION_NAME_KEY);
    showWelcome();
}

// The Supabase Realtime client automatically reconnects its socket.
// A later SUBSCRIBED callback re-tracks this tab after reconnection.
window.addEventListener("online", () => {
    console.info("[FocusRoom] Network is online; waiting for Supabase Realtime to reconnect.");
});

window.addEventListener("offline", () => {
    isPresenceTracked = false;
    console.warn("[FocusRoom] Network is offline. Presence may be temporarily unavailable.");
});

// pagehide also covers mobile/page lifecycle cases better than beforeunload alone.
// If the page is restored from the back-forward cache, join the global channel again.
window.addEventListener("pagehide", () => {
    cleanupGlobalPresence();
});

window.addEventListener("pageshow", event => {
    if (event.persisted && currentDisplayName && !presenceChannel) {
        startGlobalPresence();
    }
});

// ==============================
// FocusRoom - Personal Stopwatch (Step 6)
// ==============================

const timerDisplay = document.querySelector(".timer-display span");

const startButton = document.querySelector(".start-btn");
const pauseButton = document.querySelector(".pause-btn");
const continueButton = document.querySelector(".continue-btn");
const resetButton = document.querySelector(".reset-btn");

const TIMER_STORAGE_KEY = "focusRoomPersonalStopwatch";

let elapsedBeforeStart = 0;
let startedAt = null;
let stopwatchInterval = null;

// Format milliseconds into HH:MM:SS
function formatStopwatchTime(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return [
        String(hours).padStart(2, "0"),
        String(minutes).padStart(2, "0"),
        String(seconds).padStart(2, "0")
    ].join(":");
}

// Calculate actual elapsed time using timestamps
function getElapsedTime() {
    if (startedAt === null) {
        return elapsedBeforeStart;
    }

    return elapsedBeforeStart + (Date.now() - startedAt);
}

// Update timer display
function updateStopwatchDisplay() {
    if (!timerDisplay) return;

    timerDisplay.textContent = formatStopwatchTime(
        getElapsedTime()
    );
}

// Save stopwatch state locally
function saveStopwatchState() {
    const state = {
        elapsedBeforeStart,
        startedAt
    };

    try {
        sessionStorage.setItem(
            TIMER_STORAGE_KEY,
            JSON.stringify(state)
        );
    } catch (error) {
        console.error("[FocusRoom] Could not save stopwatch state:", error);
    }
}

// Restore stopwatch state after refresh
function restoreStopwatchState() {
    try {
        const savedState = sessionStorage.getItem(TIMER_STORAGE_KEY);

        if (!savedState) return;

        const state = JSON.parse(savedState);

        if (
            typeof state.elapsedBeforeStart !== "number" ||
            !Number.isFinite(state.elapsedBeforeStart) ||
            state.elapsedBeforeStart < 0
        ) {
            throw new Error("Invalid saved stopwatch duration.");
        }

        elapsedBeforeStart = state.elapsedBeforeStart;

        if (state.startedAt === null) {
            startedAt = null;
        } else if (
            typeof state.startedAt === "number" &&
            Number.isFinite(state.startedAt)
        ) {
            startedAt = state.startedAt;
        } else {
            throw new Error("Invalid saved stopwatch timestamp.");
        }

    } catch (error) {
        console.error("[FocusRoom] Could not restore stopwatch:", error);

        elapsedBeforeStart = 0;
        startedAt = null;

        sessionStorage.removeItem(TIMER_STORAGE_KEY);
    }
}

// Start from zero
function startStopwatch() {
    if (startedAt !== null) return;

    elapsedBeforeStart = 0;
    startedAt = Date.now();

    saveStopwatchState();
    updateStopwatchDisplay();
}

// Pause the running stopwatch
function pauseStopwatch() {
    if (startedAt === null) return;

    elapsedBeforeStart = getElapsedTime();
    startedAt = null;

    saveStopwatchState();
    updateStopwatchDisplay();
}

// Continue from previously elapsed time
function continueStopwatch() {
    if (startedAt !== null) return;

    startedAt = Date.now();

    saveStopwatchState();
    updateStopwatchDisplay();
}

// Reset stopwatch and remove saved state
function resetStopwatch() {
    elapsedBeforeStart = 0;
    startedAt = null;

    sessionStorage.removeItem(TIMER_STORAGE_KEY);

    updateStopwatchDisplay();
}

// Button events
if (startButton) {
    startButton.addEventListener("click", startStopwatch);
}

if (pauseButton) {
    pauseButton.addEventListener("click", pauseStopwatch);
}

if (continueButton) {
    continueButton.addEventListener("click", continueStopwatch);
}

if (resetButton) {
    resetButton.addEventListener("click", resetStopwatch);
}

// Restore saved state when the page loads
restoreStopwatchState();
updateStopwatchDisplay();

// Refresh the display every second.
// Actual elapsed time is always calculated from Date.now().
stopwatchInterval = setInterval(() => {
    updateStopwatchDisplay();
}, 1000);

console.info("[FocusRoom] Personal Stopwatch initialized.");
