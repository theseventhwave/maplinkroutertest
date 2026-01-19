(() => {
  const ACTIVE_THRESHOLD_MS = 600;
  const PING_RETRY_INTERVAL_MS = 200;
  const PING_RETRY_WINDOW_MS = 2000;
  const NONCE_TTL_MS = 8000;
  const MAX_DECISIONS = 3;
  const REGION_STORAGE_KEY = "mlr_test_region";
  const SETTINGS_STEP_TEXT =
    "Safari → Extensions → MapLink Router → Settings/Options. " +
    "If you do not see it there, open Settings → Apps → Safari → Extensions → " +
    "MapLink Router.";
  const GROUP_ORDER = [
    "core",
    "apple-variants",
    "google-variants",
    "wrappers-shortlinks",
    "waze-variants",
    "edge-cases"
  ];
  const GROUP_METADATA = {
    core: {
      title: "Core (Recommended)",
      description: "Most common links."
    },
    "apple-variants": {
      title: "Apple Variants",
      description: "Additional Apple Maps shapes."
    },
    "google-variants": {
      title: "Google Variants",
      description: "Expanded Google Maps shapes."
    },
    "wrappers-shortlinks": {
      title: "Wrappers & Shortlinks",
      description: "Wrapped and shortened URLs."
    },
    "waze-variants": {
      title: "Waze Variants",
      description: "Waze link variations."
    },
    "edge-cases": {
      title: "Edge Cases",
      description: "Encoding, bounds, and unsupported links."
    }
  };

  const state = {
    status: "unknown",
    settings: null,
    environment: null,
    fixtures: new Map(),
    region: null,
    regions: ["eu", "us"],
    activeTimer: null,
    retryTimer: null,
    retryWindowTimer: null,
    pingNonces: new Map(),
    routeNonces: new Map(),
  };

  const nodes = {
    statusCard: document.querySelector("[data-mlr-status]"),
    statusText: document.querySelector("[data-mlr-status-text]"),
    statusDetail: document.querySelector("[data-mlr-status-detail]"),
    settingsSteps: document.querySelector("[data-mlr-settings-steps]"),
    preferredApp: document.querySelector("[data-mlr-preferred-app]"),
    redirectsEnabled: document.querySelector("[data-mlr-redirects-enabled]"),
    retryButton: document.querySelector("[data-mlr-action=\"retry-handshake\"]"),
    settingsButton: document.querySelector("[data-mlr-action=\"settings-steps\"]"),
    guidanceSection: document.querySelector("[data-mlr-guidance=\"inactive\"]"),
    privateCard: document.querySelector("[data-mlr-private-card]"),
    privatePill: document.querySelector("[data-mlr-private-pill]"),
    decisionLog: document.querySelector("[data-mlr-decision-log]"),
    decisionLogEmpty: document.querySelector("[data-mlr-decision-log-empty]"),
    decisionLogList: document.querySelector("[data-mlr-decision-log-list]"),
    regionSelect: document.querySelector("[data-mlr-region-select]"),
    fixtureContainer: document.querySelector("[data-mlr-fixtures]"),
    fixtureTemplate: document.querySelector("[data-mlr-fixture-template]"),
  };

  const fixtureNodes = new Map();

  if (window.location.pathname !== "/") {
    window.location.replace("/");
    return;
  }

  const originTargets = document.querySelectorAll("[data-mlr-origin]");
  originTargets.forEach((node) => {
    node.textContent = window.location.origin;
  });

  initRegionSelect();
  applyStoredDecisions();
  startHandshake();
  attachActions();
  loadFixtures();

  function hydrateFixtureNodes() {
    fixtureNodes.clear();
    document.querySelectorAll("[data-mlr-fixture]").forEach((card) => {
      const fixtureId = card.getAttribute("data-mlr-fixture");
      if (!fixtureId) {
        return;
      }
      const expected = card.querySelector("[data-mlr-expected]");
      const destination = card.querySelector("[data-mlr-destination]");
      const link = card.querySelector("a[data-mlr-fixture-id]");
      fixtureNodes.set(fixtureId, {
        card,
        destination,
        expected,
        link,
      });
    });
  }

  function attachActions() {
    if (nodes.retryButton) {
      nodes.retryButton.addEventListener("click", () => {
        resetHandshakeState();
        startHandshake();
      });
    }

    if (nodes.settingsButton) {
      nodes.settingsButton.addEventListener("click", () => {
        toggleSettingsSteps();
      });
    }

    document.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) {
        return;
      }
      const fixtureId = button.getAttribute("data-mlr-fixture-id");
      if (!fixtureId) {
        return;
      }
      const action = button.getAttribute("data-mlr-fixture-action");
      const isDiagnose = action
        ? action === "diagnose"
        : button.classList.contains("mlr-button--secondary");
      const isCopy = action ? action === "copy" : button.classList.contains("mlr-button--ghost");
      const isNavigate = action === "navigate";
      if (isNavigate) {
        event.preventDefault();
        navigateFixture(fixtureId, button);
      } else if (isDiagnose) {
        event.preventDefault();
        runDiagnosis(fixtureId, button);
      } else if (isCopy) {
        event.preventDefault();
        copyFixtureLink(fixtureId, button);
      }
    });

    window.addEventListener("message", handleMessage);
  }

  function resetHandshakeState() {
    clearTimeout(state.activeTimer);
    clearTimeout(state.retryWindowTimer);
    clearInterval(state.retryTimer);
    state.activeTimer = null;
    state.retryWindowTimer = null;
    state.retryTimer = null;
    state.pingNonces.clear();
    state.status = "unknown";
    state.settings = null;
    state.environment = null;
    updateStatusUI();
  }

  function startHandshake() {
    updateStatusUI();
    scheduleActiveThreshold();
    sendPing();
    state.retryTimer = setInterval(sendPing, PING_RETRY_INTERVAL_MS);
    state.retryWindowTimer = setTimeout(() => {
      clearInterval(state.retryTimer);
      state.retryTimer = null;
    }, PING_RETRY_WINDOW_MS);
  }

  function scheduleActiveThreshold() {
    state.activeTimer = setTimeout(() => {
      if (state.status !== "active") {
        state.status = "inactive";
        updateStatusUI();
      }
    }, ACTIVE_THRESHOLD_MS);
  }

  function sendPing() {
    const nonce = createNonce();
    const payload = {
      type: "MLR_PING",
      nonce,
      page: "/",
    };
    trackNonce(state.pingNonces, nonce);
    window.postMessage(payload, window.location.origin);
  }

  function runDiagnosis(fixtureId, button) {
    const fixture = state.fixtures.get(fixtureId);
    const fixtureNode = fixtureNodes.get(fixtureId);
    const linkHref = getFixtureUrl(fixture) || fixtureNode?.link?.getAttribute("href");
    if (!linkHref) {
      renderDiagnosis(fixtureNode?.card, {
        reason: "no_match",
        chosenRedirectUrl: null,
        notes: ["Missing fixture URL for diagnostic request."],
      });
      return;
    }
    const nonce = createNonce();
    trackNonce(state.routeNonces, nonce, fixtureId);
    button.disabled = true;
    const payload = {
      type: "MLR_ROUTE_REQUEST",
      nonce,
      fixtureId,
      inputUrl: linkHref,
    };
    window.postMessage(payload, window.location.origin);
    setTimeout(() => {
      button.disabled = false;
    }, 800);
  }

  function copyFixtureLink(fixtureId, button) {
    const fixture = state.fixtures.get(fixtureId);
    const fixtureNode = fixtureNodes.get(fixtureId);
    const linkHref = getFixtureUrl(fixture) || fixtureNode?.link?.getAttribute("href");
    if (!linkHref) {
      flashButton(button, "No link found");
      return;
    }
    copyText(linkHref)
      .then(() => {
        flashButton(button, "Copied");
      })
      .catch(() => {
        flashButton(button, "Press and hold to copy");
      });
  }

  function navigateFixture(fixtureId, button) {
    const fixture = state.fixtures.get(fixtureId);
    const fixtureNode = fixtureNodes.get(fixtureId);
    const linkHref = getFixtureUrl(fixture) || fixtureNode?.link?.getAttribute("href");
    if (!linkHref) {
      flashButton(button, "No link found");
      return;
    }
    window.location.assign(linkHref);
  }

  function loadFixtures() {
    fetch("test-fixtures.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Fixture load failed");
        }
        return response.json();
      })
      .then((payload) => {
        if (!payload || !Array.isArray(payload.fixtures)) {
        return;
      }
      if (Array.isArray(payload.regions) && payload.regions.length > 0) {
        state.regions = payload.regions.slice();
        syncRegionOptions();
        }
        payload.fixtures.forEach((fixture) => {
          if (!fixture || typeof fixture.id !== "string") {
            return;
          }
          state.fixtures.set(fixture.id, fixture);
        });
        renderFixtureGroups(payload.fixtures);
        hydrateFixtureNodes();
        applyRegionToFixtures();
        updateFixtureExpectations();
      })
      .catch(() => {
        updateFixtureExpectations();
      });
  }

  function handleMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    const data = event.data;
    if (
      !isPlainObject(data) ||
      !hasOwn(data, "type") ||
      typeof data.type !== "string"
    ) {
      return;
    }
    if (data.type === "MLR_PONG") {
      handlePong(data);
      return;
    }
    if (data.type === "MLR_ROUTE_RESPONSE") {
      handleRouteResponse(data);
      return;
    }
    if (data.type === "MLR_DECISION") {
      handleDecision(data);
    }
  }

  function handlePong(data) {
    if (!validatePong(data)) {
      return;
    }
    if (!consumeNonce(state.pingNonces, data.nonce)) {
      return;
    }
    state.status = "active";
    state.settings = data.settings;
    state.environment = data.environment || null;
    updateStatusUI();
    updateFixtureExpectations();
  }

  function handleRouteResponse(data) {
    if (!validateRouteResponse(data)) {
      return;
    }
    const nonceEntry = consumeNonce(state.routeNonces, data.nonce, true);
    if (!nonceEntry) {
      return;
    }
    renderDiagnosis(fixtureNodes.get(data.fixtureId)?.card, data);
  }

  function handleDecision(data) {
    if (!validateDecision(data)) {
      return;
    }
    appendDecisionLog({
      ts: data.ts,
      fixtureId: data.fixtureId,
      reason: data.reason,
      inputUrl: data.inputUrl,
      chosenRedirectUrl: data.chosenRedirectUrl,
    });
  }

  function updateStatusUI() {
    if (!nodes.statusCard || !nodes.statusText || !nodes.statusDetail) {
      return;
    }
    nodes.statusCard.setAttribute("data-mlr-status", state.status);
    if (state.status === "active") {
      nodes.statusText.textContent = "Active on this site";
      nodes.statusDetail.textContent =
        "MapLink Router responded. Use Diagnose for deterministic routing checks.";
    } else if (state.status === "inactive") {
      nodes.statusText.textContent = "Not active on this site";
      nodes.statusDetail.textContent =
        "Enable the extension and grant Website Access to this domain.";
    } else {
      nodes.statusText.textContent = "Checking for MapLink Router...";
      nodes.statusDetail.textContent =
        "Waiting for a response from the Safari extension.";
    }

    if (nodes.settingsSteps) {
      nodes.settingsSteps.textContent = SETTINGS_STEP_TEXT;
      if (state.status === "active") {
        nodes.settingsSteps.hidden = true;
      }
    }

    updateStatusMeta();
    updateGuidanceVisibility();
    updateFixtureExpectations();
  }

  function updateStatusMeta() {
    const settings = state.settings;
    if (!settings || state.status !== "active") {
      setMetaValue(nodes.preferredApp, "Unknown");
      setMetaValue(nodes.redirectsEnabled, "Unknown");
      resetPrivatePill();
      return;
    }

    setMetaValue(nodes.preferredApp, formatPreferredApp(settings.preferredMapsApp));
    setMetaValue(
      nodes.redirectsEnabled,
      settings.redirectsEnabled ? "On" : "Off"
    );

    if (!state.environment || !state.environment.isPrivateContextHint) {
      resetPrivatePill();
      return;
    }
    if (nodes.privateCard && nodes.privatePill) {
      nodes.privatePill.textContent = "Private Browsing detected";
      nodes.privatePill.classList.remove("mlr-pill--sky");
      nodes.privatePill.classList.add("mlr-pill--orange");
    }
  }

  function updateGuidanceVisibility() {
    if (!nodes.guidanceSection) {
      return;
    }
    nodes.guidanceSection.hidden = state.status === "active";
  }

  function updateFixtureExpectations() {
    fixtureNodes.forEach((entry, fixtureId) => {
      const expectedNode = entry.expected;
      if (!expectedNode) {
        return;
      }
      const fixture = state.fixtures.get(fixtureId);
      const text = buildExpectedText(fixture);
      expectedNode.textContent = text;
    });
  }

  function buildExpectedText(fixture) {
    const base = fixture ? expectedForFixture(fixture) : "route to your preferred app.";
    if (state.status !== "active") {
      return `Expected when MapLink Router is active: ${base}`;
    }
    return `Expected: ${base}`;
  }

  function isLatLonPair(value) {
    if (typeof value !== "string") {
      return false;
    }
    return /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(value.trim());
  }

  function fixtureHasCoordinates(fixture) {
    const url = getFixtureUrl(fixture);
    if (!url) {
      return false;
    }
    try {
      const parsed = new URL(url);
      const params = parsed.searchParams;
      if (params.has("ll") || params.has("sll")) {
        return true;
      }
      const query = params.get("query") || params.get("q");
      if (isLatLonPair(query || "")) {
        return true;
      }
      const destination = params.get("destination") || params.get("daddr");
      if (isLatLonPair(destination || "")) {
        return true;
      }
      if (/@-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/.test(parsed.pathname)) {
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function fixtureHasOrigin(fixture) {
    const url = getFixtureUrl(fixture);
    if (!url) {
      return false;
    }
    try {
      const parsed = new URL(url);
      const params = parsed.searchParams;
      if (params.get("saddr") || params.get("origin") || params.get("origin_place_id")) {
        return true;
      }
      if (parsed.pathname.includes("/maps/dir/")) {
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function expectedForFixture(fixture) {
    if (!state.settings) {
      return "route to your preferred app.";
    }

    if (!state.settings.redirectsEnabled) {
      return "no redirect; link opens as-is.";
    }

    const preferred = state.settings.preferredMapsApp;
    const intent = fixture.intentType;
    const provider = getFixtureProvider(fixture);

    if (intent === "shortlink-noop") {
      return "no redirect; short link expansion is intentionally not performed.";
    }

    if (intent === "wrapper-unroll") {
      return "unwraps to a stable Google Maps URL first, then routes if needed.";
    }

    if (intent === "wrapper-ambiguous") {
      return "no redirect; wrapper is ambiguous or unsafe.";
    }

    if (intent === "invalid-coords") {
      return "no redirect; coordinates are out of bounds.";
    }

    if (intent === "unsupported") {
      return "no redirect; unsupported or unsafe link.";
    }

    if (intent === "cid-canonicalization" && (preferred === "apple" || preferred === "waze")) {
      return (
        "bounded canonicalization fallback (up to 3.0 seconds hard max). " +
        "May briefly open Google Maps to resolve the place; if it never resolves, " +
        "you will remain on Google Maps."
      );
    }

    if (provider && provider === preferred) {
      return "success may be leaving the link unchanged; iOS may still open the app.";
    }

    if (preferred === "waze") {
      if (intent === "directions") {
        const originNote = fixtureHasOrigin(fixture)
          ? " Waze uses your current location as the start (origin may be ignored)."
          : " Waze uses your current location as the start.";
        const destinationNote = fixtureHasCoordinates(fixture)
          ? ""
          : " Text-only destinations are best-effort and may show \"No results found.\"";
        return `route with directions to Waze.${originNote}${destinationNote}`;
      }

      if (intent === "place" && !fixtureHasCoordinates(fixture)) {
        return "route to Waze; text-only searches are best-effort and may show \"No results found.\"";
      }
    }

    if (intent === "directions") {
      return "route with directions to your preferred app.";
    }

    if (intent === "coordinate-only") {
      return "route by coordinates in your preferred app.";
    }

    return "route to your preferred app.";
  }

  function renderDiagnosis(card, data) {
    if (!card) {
      return;
    }
    let node = card.querySelector("[data-mlr-diagnose-result]");
    if (!node) {
      node = document.createElement("p");
      node.className = "mlr-muted";
      node.setAttribute("data-mlr-diagnose-result", "true");
      card.appendChild(node);
    }
    const lines = [];
    lines.push(`Diagnose: ${formatReason(data.reason)}.`);
    if (data.chosenRedirectUrl) {
      lines.push(`Redirect URL: ${data.chosenRedirectUrl}`);
    } else {
      lines.push("Redirect URL: none");
    }
    if (Array.isArray(data.notes) && data.notes.length > 0) {
      lines.push(data.notes.join(" "));
    }
    node.textContent = lines.join(" ");
  }

  function toggleSettingsSteps() {
    if (!nodes.settingsSteps) {
      return;
    }
    const isHidden = nodes.settingsSteps.hidden;
    nodes.settingsSteps.hidden = !isHidden;
  }

  function setMetaValue(node, value) {
    if (node) {
      node.textContent = value;
    }
  }

  function formatPreferredApp(value) {
    if (value === "google") {
      return "Google Maps";
    }
    if (value === "waze") {
      return "Waze";
    }
    if (value === "apple") {
      return "Apple Maps";
    }
    return "Unknown";
  }

  function createNonce() {
    if (window.crypto?.getRandomValues) {
      const bytes = new Uint8Array(8);
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return Math.random().toString(16).slice(2);
  }

  function trackNonce(map, nonce, fixtureId = null) {
    const timeoutId = setTimeout(() => {
      map.delete(nonce);
    }, NONCE_TTL_MS);
    map.set(nonce, { timeoutId, fixtureId });
  }

  function consumeNonce(map, nonce, withFixture = false) {
    const entry = map.get(nonce);
    if (!entry) {
      return null;
    }
    clearTimeout(entry.timeoutId);
    map.delete(nonce);
    if (withFixture) {
      return entry;
    }
    return true;
  }

  function validatePong(data) {
    if (!hasOwn(data, "nonce") || typeof data.nonce !== "string") {
      return false;
    }
    if (!hasOwn(data, "settings") || !isPlainObject(data.settings)) {
      return false;
    }
    const settings = data.settings;
    if (
      !hasOwn(settings, "preferredMapsApp") ||
      typeof settings.preferredMapsApp !== "string"
    ) {
      return false;
    }
    if (
      !hasOwn(settings, "redirectsEnabled") ||
      typeof settings.redirectsEnabled !== "boolean"
    ) {
      return false;
    }
    if (
      !hasOwn(settings, "preferAppSchemes") ||
      typeof settings.preferAppSchemes !== "boolean"
    ) {
      return false;
    }
    if (hasOwn(data, "environment") && data.environment !== null) {
      if (!isPlainObject(data.environment)) {
        return false;
      }
      const env = data.environment;
      if (
        hasOwn(env, "isPrivateContextHint") &&
        typeof env.isPrivateContextHint !== "boolean"
      ) {
        return false;
      }
      if (hasOwn(env, "websiteAccessHint")) {
        const hint = env.websiteAccessHint;
        if (typeof hint !== "string") {
          return false;
        }
        if (!["all", "selected", "unknown"].includes(hint)) {
          return false;
        }
      }
    }
    return true;
  }

  function validateRouteResponse(data) {
    if (!hasOwn(data, "nonce") || typeof data.nonce !== "string") {
      return false;
    }
    if (!hasOwn(data, "fixtureId") || typeof data.fixtureId !== "string") {
      return false;
    }
    if (!hasOwn(data, "inputUrl") || typeof data.inputUrl !== "string") {
      return false;
    }
    if (!hasOwn(data, "chosenRedirectUrl")) {
      return false;
    }
    if (data.chosenRedirectUrl !== null && typeof data.chosenRedirectUrl !== "string") {
      return false;
    }
    if (!hasOwn(data, "reason") || typeof data.reason !== "string") {
      return false;
    }
    if (hasOwn(data, "notes")) {
      if (!Array.isArray(data.notes)) {
        return false;
      }
      for (const note of data.notes) {
        if (typeof note !== "string") {
          return false;
        }
      }
    }
    return true;
  }

  function validateDecision(data) {
    if (!hasOwn(data, "ts") || typeof data.ts !== "string") {
      return false;
    }
    if (!hasOwn(data, "fixtureId") || typeof data.fixtureId !== "string") {
      return false;
    }
    if (!hasOwn(data, "inputUrl") || typeof data.inputUrl !== "string") {
      return false;
    }
    if (!hasOwn(data, "reason") || typeof data.reason !== "string") {
      return false;
    }
    if (!hasOwn(data, "chosenRedirectUrl")) {
      return false;
    }
    if (data.chosenRedirectUrl !== null && typeof data.chosenRedirectUrl !== "string") {
      return false;
    }
    return true;
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== "object") {
      return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function hasOwn(target, key) {
    return Object.prototype.hasOwnProperty.call(target, key);
  }

  function formatReason(reason) {
    return reason.replace(/_/g, " ");
  }

  function resetPrivatePill() {
    if (!nodes.privateCard || !nodes.privatePill) {
      return;
    }
    nodes.privatePill.textContent = "Test normal mode first";
    nodes.privatePill.classList.remove("mlr-pill--orange");
    nodes.privatePill.classList.add("mlr-pill--sky");
  }

  function getFixtureProvider(fixture) {
    const url = getFixtureUrl(fixture);
    if (!url) {
      return null;
    }
    let host = null;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    if (!host) {
      return null;
    }
    const normalizedHost = host.toLowerCase();
    if (normalizedHost === "maps.apple.com") {
      return "apple";
    }
    if (
      normalizedHost === "waze.com" ||
      normalizedHost === "www.waze.com"
    ) {
      return "waze";
    }
    if (
      normalizedHost === "google.com" ||
      normalizedHost.startsWith("google.") ||
      normalizedHost.includes(".google.")
    ) {
      return "google";
    }
    return null;
  }

  function initRegionSelect() {
    const stored = readRegionPreference();
    const initial = stored || detectDefaultRegion();
    setRegion(initial, { persist: false });
    if (!nodes.regionSelect) {
      return;
    }
    nodes.regionSelect.addEventListener("change", (event) => {
      const value = event.target.value;
      setRegion(value, { persist: true });
      applyRegionToFixtures();
      updateFixtureExpectations();
    });
  }

  function readRegionPreference() {
    try {
      return window.localStorage?.getItem(REGION_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function writeRegionPreference(value) {
    try {
      window.localStorage?.setItem(REGION_STORAGE_KEY, value);
    } catch {
      // Ignore storage errors.
    }
  }

  function setRegion(value, { persist } = { persist: true }) {
    if (!value || !state.regions.includes(value)) {
      state.region = state.regions[0];
    } else {
      state.region = value;
    }
    if (nodes.regionSelect) {
      nodes.regionSelect.value = state.region;
    }
    if (persist) {
      writeRegionPreference(state.region);
    }
  }

  function detectDefaultRegion() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (tz.startsWith("America/")) {
      return "us";
    }
    if (tz.startsWith("Europe/")) {
      return "eu";
    }
    const language = navigator.language ? navigator.language.toLowerCase() : "";
    if (language.endsWith("-us")) {
      return "us";
    }
    return "eu";
  }

  function syncRegionOptions() {
    if (!nodes.regionSelect) {
      return;
    }
    const current = nodes.regionSelect.value;
    nodes.regionSelect.textContent = "";
    state.regions.forEach((region) => {
      const option = document.createElement("option");
      option.value = region;
      option.textContent = region === "us" ? "United States" : "Europe";
      nodes.regionSelect.appendChild(option);
    });
    const stored = readRegionPreference();
    setRegion(stored || current || detectDefaultRegion(), { persist: false });
  }

  function resolveFixtureRegionData(fixture) {
    if (!fixture || typeof fixture !== "object") {
      return null;
    }
    if (fixture.regions && state.region && fixture.regions[state.region]) {
      return fixture.regions[state.region];
    }
    if (fixture.url || fixture.destinationLabel) {
      return { url: fixture.url, destinationLabel: fixture.destinationLabel };
    }
    return null;
  }

  function getFixtureUrl(fixture) {
    const regionData = resolveFixtureRegionData(fixture);
    return regionData && typeof regionData.url === "string" ? regionData.url : null;
  }

  function applyRegionToFixtures() {
    fixtureNodes.forEach((entry, fixtureId) => {
      const fixture = state.fixtures.get(fixtureId);
      if (!fixture) {
        return;
      }
      const regionData = resolveFixtureRegionData(fixture);
      if (entry.link && regionData?.url) {
        entry.link.setAttribute("href", regionData.url);
      }
      if (entry.destination) {
        const label =
          typeof regionData?.destinationLabel === "string"
            ? regionData.destinationLabel.trim()
            : "";
        entry.destination.textContent = label ? `Destination: ${label}` : "";
        entry.destination.hidden = !label;
      }
    });
  }

  function copyText(value) {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(value);
    }
    return new Promise((resolve, reject) => {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.select();
      let success = false;
      try {
        success = document.execCommand("copy");
      } catch {
        success = false;
      }
      document.body.removeChild(textarea);
      if (success) {
        resolve();
      } else {
        reject(new Error("Copy failed"));
      }
    });
  }

  function flashButton(button, text) {
    const original = button.textContent;
    button.textContent = text;
    button.disabled = true;
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1200);
  }

  function appendDecisionLog(entry) {
    const stored = readDecisionLog();
    stored.unshift(entry);
    const trimmed = stored.slice(0, MAX_DECISIONS);
    sessionStorage.setItem("mlr_decisions", JSON.stringify(trimmed));
    renderDecisionLog(trimmed);
  }

  function readDecisionLog() {
    try {
      const raw = sessionStorage.getItem("mlr_decisions");
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((entry) => isPlainObject(entry));
    } catch {
      return [];
    }
  }

  function applyStoredDecisions() {
    const entries = readDecisionLog();
    renderDecisionLog(entries);
  }

  function renderDecisionLog(entries) {
    if (!nodes.decisionLog || !nodes.decisionLogList || !nodes.decisionLogEmpty) {
      return;
    }
    if (!entries || entries.length === 0) {
      nodes.decisionLog.hidden = true;
      nodes.decisionLogEmpty.hidden = false;
      nodes.decisionLogList.textContent = "";
      return;
    }
    nodes.decisionLog.hidden = false;
    nodes.decisionLogEmpty.hidden = true;
    nodes.decisionLogList.textContent = "";
    entries.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "mlr-muted";
      const parts = [];
      if (entry.ts) {
        parts.push(entry.ts);
      }
      if (entry.fixtureId) {
        parts.push(`fixture: ${entry.fixtureId}`);
      }
      if (entry.reason) {
        parts.push(`reason: ${formatReason(entry.reason)}`);
      }
      item.textContent = parts.join(" • ");
      nodes.decisionLogList.appendChild(item);
    });
  }

  function renderFixtureGroups(fixtures) {
    if (!nodes.fixtureContainer || !nodes.fixtureTemplate) {
      return;
    }
    nodes.fixtureContainer.textContent = "";
    const groups = new Map();
    fixtures.forEach((fixture) => {
      const groupKey = normalizeGroupKey(fixture?.group);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey).push(fixture);
    });

    GROUP_ORDER.forEach((groupKey) => {
      const entries = groups.get(groupKey);
      if (!entries || entries.length === 0) {
        return;
      }
      const details = document.createElement("details");
      details.className = "mlr-fixture-group";
      details.setAttribute("data-mlr-group", groupKey);
      if (groupKey === "core") {
        details.open = true;
      }
      const summary = document.createElement("summary");
      summary.className = "mlr-fixture-group-summary";
      summary.setAttribute("data-mlr-group-toggle", "true");
      const title = document.createElement("span");
      title.className = "mlr-fixture-group-title";
      const meta = document.createElement("span");
      meta.className = "mlr-fixture-group-meta";
      const metadata = GROUP_METADATA[groupKey];
      title.textContent = metadata?.title || "Fixtures";
      meta.textContent = metadata?.description || "";
      summary.appendChild(title);
      summary.appendChild(meta);
      details.appendChild(summary);

      const grid = document.createElement("div");
      grid.className = "mlr-grid mlr-fixtures-grid";
      entries.forEach((fixture) => {
        const card = buildFixtureCard(fixture);
        if (card) {
          grid.appendChild(card);
        }
      });
      details.appendChild(grid);
      nodes.fixtureContainer.appendChild(details);
    });
  }

  function buildFixtureCard(fixture) {
    if (!fixture || typeof fixture.id !== "string") {
      return null;
    }
    const fragment = nodes.fixtureTemplate.content.cloneNode(true);
    const card = fragment.querySelector("[data-mlr-fixture]");
    if (!card) {
      return null;
    }
    card.setAttribute("data-mlr-fixture", fixture.id);
    const title = fragment.querySelector("[data-mlr-fixture-title]");
    if (title) {
      title.textContent = fixture.title || fixture.id;
    }
    const intentNode = fragment.querySelector("[data-mlr-fixture-intent]");
    if (intentNode) {
      const badge = getIntentBadge(fixture.intentType);
      intentNode.textContent = badge.label;
      intentNode.classList.remove("mlr-pill--sand", "mlr-pill--sky", "mlr-pill--orange");
      intentNode.classList.add(badge.tone);
    }
    const actionNodes = fragment.querySelectorAll("[data-mlr-fixture-id]");
    actionNodes.forEach((node) => {
      node.setAttribute("data-mlr-fixture-id", fixture.id);
    });
    const navigateButton = fragment.querySelector("[data-mlr-fixture-action=\"navigate\"]");
    if (navigateButton && fixture.navigate === false) {
      navigateButton.hidden = true;
    }
    return card;
  }

  function getIntentBadge(intentType) {
    if (intentType === "coordinate-only") {
      return { label: "Coordinate-only", tone: "mlr-pill--sky" };
    }
    if (intentType === "directions") {
      return { label: "Directions", tone: "mlr-pill--orange" };
    }
    if (intentType === "cid-canonicalization") {
      return { label: "CID canonicalization", tone: "mlr-pill--sand" };
    }
    if (intentType === "shortlink-noop") {
      return { label: "Short link (no redirect)", tone: "mlr-pill--sand" };
    }
    if (intentType === "wrapper-unroll") {
      return { label: "Wrapper unroll", tone: "mlr-pill--orange" };
    }
    if (intentType === "wrapper-ambiguous") {
      return { label: "Wrapper ambiguous", tone: "mlr-pill--orange" };
    }
    if (intentType === "legacy-search") {
      return { label: "Legacy search", tone: "mlr-pill--sand" };
    }
    if (intentType === "same-provider") {
      return { label: "Same-provider", tone: "mlr-pill--sand" };
    }
    if (intentType === "invalid-coords") {
      return { label: "Invalid coordinates", tone: "mlr-pill--orange" };
    }
    if (intentType === "unsupported") {
      return { label: "Unsupported (no redirect)", tone: "mlr-pill--orange" };
    }
    return { label: "Place search", tone: "mlr-pill--sand" };
  }

  function normalizeGroupKey(group) {
    if (GROUP_ORDER.includes(group)) {
      return group;
    }
    return "core";
  }
})();
