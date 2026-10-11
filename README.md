
<div align="center">

# 🧠 Google Flow Browser MCP

**Control [Google Flow](https://flow.google.com) — image & video generation — directly from your AI agent via MCP.**

<p>
  <img src="https://img.shields.io/badge/version-1.0.0-blue?style=flat-square" alt="Version 1.0.0">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square" alt="Node >= 18">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square" alt="License MIT">
  <img src="https://img.shields.io/badge/MCP-server-8A2BE2?style=flat-square" alt="MCP Server">
  <img src="https://img.shields.io/badge/OpenCode-ready-4CAF50?style=flat-square" alt="OpenCode Ready">
</p>

<br>

[✨ Features](#-features) •
[🚀 Quick Start](#-quick-start) •
[🔧 Tools](#-tools) •
[⚙️ Configuration](#️-configuration) •
[🛡️ Safety](#️-safety--ethics)

<br>

</div>

---

> **🇫🇷 Ce serveur MCP permet à votre agent AI (OpenCode) d'utiliser Google Flow pour générer des images et des vidéos, via votre propre compte Google et sans partager vos identifiants.**

---

## 📸 What It Does

This MCP server connects your AI agent to **[Google Flow](https://flow.google.com)** — Google's creative suite for image and video generation. Your agent can:

- 🎨 **Generate images** with Nano Banana 2.1, Nano Banana Pro, or Nano Banana 2 Lite
- 🎬 **Create videos** and scenes with characters
- 🧑 **Manage characters** and scenes in your Flow workspace
- 🖼️ **Use Grid Architect** for batch shot generation
- 🔍 **Discover and control** any Flow tool programmatically

All through your **own Google account** — no API keys, no third-party tokens.

---

## ✨ Features

<table>
<tr>
  <td width="50%">

### 🎯 For AI Agents
  </td>
  <td width="50%">

### 🔒 For Humans
  </td>
</tr>
<tr>
  <td>

- **15+ MCP tools** ready to use
- **Smart job queue** — no parallel conflicts
- **Auto-discover UI** — adapts to Flow changes
- **Structured logging** for debugging
- **Safe actions** — resilient click/fill logic
  </td>
  <td>

- **Your account, your data** — no token sharing
- **No password asked** — ever
- **Clean safety rules** — stops on captcha/verification
- **Config backup** before any modification
- **Single-job queue** — no runaway generation
  </td>
</tr>
</table>

---

## 🚀 Quick Start

### Prerequisites

| What | Why |
|------|-----|
| **Node.js ≥ 18** | Runtime for the MCP server |
| **Google Chrome** | Required for browser automation |
| **OpenCode** | AI agent that connects to MCP servers |
| **A Google account** | To use Google Flow (yours, not shared) |

### 1️⃣ Install

```bash
git clone https://github.com/TMSSS05/google-flow-browser-mcp.git
cd google-flow-browser-mcp
npm install
```

### 2️⃣ Configure your Google profile

```bash
cp config/flow.config.example.json config/flow.config.json
```

Edit `config/flow.config.json`:

```json
{
  "defaultProfile": "your-label",
  "profiles": {
    "your-label": {
      "sourceProfile": "Profile 1",
      "expectedAccount": "your.email@gmail.com"
    }
  },
  "chromeUserDataDir": "/home/you/.config/google-chrome"
}
```

`profiles` is the single source of truth for every account this tool knows about — `defaultProfile` picks which entry `flow_connect` uses when you don't pass a `profile` arg. `your-label` is just a name you choose (no requirement to be an email or match anything). You never have to hand-edit this beyond the first entry — see "Adding another Google account" below; new profiles register themselves here automatically the first time they connect successfully.

> 💡 **Finding your Chrome profile:**  
> Open Chrome and go to `chrome://version/`. Look for **"Profile Path"** — the last folder name is your profile (e.g., `Profile 1`), and the path before it is your `chromeUserDataDir`. `sourceProfile` is only used as a one-time seed — see below.

> ⚠️ Nothing here needs to already be signed into Flow — the first `flow_connect` call handles that (next step).

### 3️⃣ Make scripts executable

```bash
chmod +x scripts/*.sh
```

### 4️⃣ Start the MCP server

```bash
./scripts/start-mcp.sh
```

There is no separate "launch Chrome first" step — `flow_connect` launches Chrome itself, from a **persistent** profile (`chrome-profile-{profile}/` in this repo, gitignored — one per entry in config's `profiles` map). The very first `flow_connect` call for a given profile needs a VISIBLE window (don't pass `headless`/`virtual_display`) so you can click your Google account in the account-chooser and complete 2FA if prompted — a one-time thing, unless seeded from `sourceProfile` (see below), which skips it entirely. Every `flow_connect` call after that reuses the same authenticated session automatically, in any display mode, with no further sign-in.

#### Adding another Google account

Each account gets its own independent, isolated Chrome profile — never your real everyday Chrome profile directly (see "why isolated copies, not your real profile" below). Two ways to set one up — **you never have to hand-edit `config/flow.config.json`'s `profiles` map**; a successful connect writes its own entry there automatically, backing up the previous config first:

**A) Fresh sign-in through this tool** (simplest, but needs one manual step):
```
flow_connect({ profile: "some-label", headless: false, virtual_display: false })
```
Pick any `profile` label you like — it's just a directory name, no requirement to be an email or match anything. This opens a real visible Chrome window on Google's account-chooser; sign into whichever account you want, complete 2FA if prompted, then re-run `flow_connect` with the same `profile` key. The moment the account is verified, its email is written into `config.profiles["some-label"]` automatically. Every call after that reuses it automatically.

**B) Seed from an already-signed-in system Chrome profile** (no manual step at connect time, but requires prep in your *real* Chrome first):
1. In your real Chrome, create a new profile (Chrome's own profile picker → "Add") and sign into the Google account you want to use.
2. **While still in that profile**, visit **https://flow.google.com** and accept Flow's terms/contract once — otherwise the seeded copy will land on the same one-time contract-acceptance screen the very first time you use it.
3. Find that profile's directory name: go to `chrome://version/` in it and read **"Profile Path"** — the last folder name (e.g. `Profile 3`) is what you need.
4. Hand that name to `flow_connect` as `source_profile`, along with your own chosen `profile` label — only needed this once:
   ```
   flow_connect({ profile: "some-label", source_profile: "Profile 3", virtual_display: true })
   ```
   This copies that system profile's session into its own `chrome-profile-some-label/` — no interactive sign-in needed, works headed or on a virtual display right away. On success, `config.profiles["some-label"] = { sourceProfile: "Profile 3", expectedAccount: "<discovered email>" }` gets written automatically — future connects need only `{ profile: "some-label" }`, no `source_profile` required again (useful if the persistent copy ever needs re-seeding after being deleted).

**Why an isolated copy instead of automating your real profile directly?** Chrome won't run two instances against the same profile directory at once (`SingletonLock`) — pointing automation straight at your daily-driver profile would either fail to start or force-close your real browser. The copy is a one-time snapshot at connect time (not a live sync), so your real profile is never touched again afterward and automation flags never bleed into your everyday browsing fingerprint.

Switching `profile` on a later call automatically closes whatever's running and relaunches under the requested one. Once a profile has a recorded `expectedAccount`, future connects under that same key verify against it and fail loud on a mismatch; a brand-new profile with nothing recorded yet just reports whichever account is found.

#### Server without a screen

Ask your agent to "create a profile" (or a second one). It calls `flow_login_start({ profile: "main" })`,
which opens Chrome for that profile on a virtual display and serves it as a web page on
`127.0.0.1:6080` (x11vnc + noVNC — `apt install xvfb x11vnc novnc websockify`). The agent hands you
two things:

```bash
ssh -N -L 6080:127.0.0.1:6080 you@your-server     # on your own computer
# then open http://localhost:6080/vnc.html?autoconnect=1&resize=scale
```

Sign in to Google there (2FA included) and accept Flow's terms if asked. `flow_login_wait` notices the
sign-in, records the account in `config.profiles`, and closes the viewer. From then on
`flow_connect({ profile: "main", virtual_display: true })` runs without a screen. The viewer only ever
listens on localhost; set `loginSshHost` in the config if the suggested ssh target is wrong
(`loginWebPort` / `loginVncPort` change the ports).

### 5️⃣ Register with OpenCode

```bash
./scripts/register-opencode.sh
```

> 🔄 **Restart OpenCode** after registration for the changes to take effect.

### ✅ Verify it works

```bash
./scripts/test-flow-image.sh
```

---

## 🔄 flow.google.com (October 2026)

Flow moved from `labs.google/fx/tools/flow` (Next.js, tRPC) to **`flow.google.com`** (Angular). What changed for this server:

- **Data comes from Flow's own RPCs**, not the DOM. Gallery tiles no longer carry ids or links, and the old
  `labs.google/fx/api/trpc/*` endpoints are gone. `src/browser/rpc.js` calls Flow's `batchexecute` endpoint from
  inside the page (same cookies and XSRF token Flow uses); `src/browser/flow-api.js` wraps it:
  project list (`UpteDb`), a project's generations and every media step with its prompt (`Zzl0ze`), and a signed
  full-size download URL per media item (`as29s`). New results are detected by diffing that listing, not the gallery.
- **Bot check:** Flow scores the session with reCAPTCHA. Prompts typed at 5 ms/char and teleport clicks got edits
  rejected ("We noticed some unusual activity … You have not been charged"); typing at a human pace, moving the
  pointer before clicks (`humanClick`), and opening a generation by clicking its gallery tile instead of loading
  `/edit/{id}` directly made them go through. A rejection is reported at once with
  `MANUAL_VERIFICATION_REQUIRED` instead of waiting for a timeout.
- **Routes:** project `/project/{id}`, generation `/project/{id}/edit/{id}`, characters `/project/{id}/character`,
  tools `/project/{id}/tools`. Scenes and Images are only gallery filters.
- **Settings:** the composer's settings popover is shared by image and video; it is applied on every call (never
  cached) and image generation refuses to click unless the composer shows an image model.

## 🏗️ Architecture

```
google-flow-browser-mcp/
│
├── 📂 config/
│   ├── flow.config.example.json    # Configuration template
│   └── selectors.map.json          # UI selectors (auto-populated)
│
├── 📂 scripts/
│   ├── start-browser.sh            # DEPRECATED — flow_connect launches Chrome itself now
│   ├── start-mcp.sh                # Start the MCP server
│   ├── test-flow-image.sh          # Quick integration test
│   └── register-opencode.sh        # Register in OpenCode config
│
├── 📂 src/
│   ├── index.js                    # MCP server entry point
│   │
│   ├── 📁 browser/                 # Chrome & CDP management
│   │   ├── connect.js              # CDP connection manager
│   │   ├── launch-profile.js       # Chrome profile launcher
│   │   ├── account-check.js        # Verify Google account
│   │   └── safe-actions.js         # Safe click, fill, detection
│   │
│   ├── 📁 tools/                   # All MCP tool implementations
│   │   ├── flow-open.js            # Navigate to Flow
│   │   ├── flow-status.js          # Connection status
│   │   ├── generate-image.js       # Image generation
│   │   ├── generate-video.js       # Video generation (setup only)
│   │   ├── download-latest.js      # Download generated files
│   │   ├── create-character.js     # Create a character
│   │   ├── import-character.js     # Import character JSON
│   │   ├── open-characters.js      # List characters
│   │   ├── create-scene.js         # Create a scene
│   │   ├── open-tools-gallery.js   # Open tools gallery
│   │   ├── grid-architect.js       # Batch shot generation
│   │   ├── discover-ui.js          # UI discovery & mapping
│   │   └── use-flow-tool.js        # Generic tool opener
│   │
│   ├── 📁 queue/                   # Job management
│   │   └── job-queue.js            # Single-job queue
│   │
│   └── 📁 utils/                   # Helpers
│       ├── config.js               # Config loader
│       ├── logger.js               # Structured logging
│       ├── errors.js               # Error codes & types
│       ├── file-manager.js         # File download/save
│       └── screenshots.js          # Screenshot capture
│
└── 📂 output/                      # Generated files land here
```

---

## 🔧 Tools

All tools are organized by function for easy discovery.

### 🌐 Connection & Status

| Tool | Description |
|------|-------------|
| `flow_connect` | Launch Chrome, connect CDP, navigate to Google Flow |
| `flow_disconnect` | Close browser and clean up all connections |
| `flow_status` | Full status: connection, Flow loaded, account, queue state |
| `flow_account_check` | Verify logged-in account matches configured email |
| `flow_screenshot` | Capture a screenshot of the current Flow page |

### 🎨 Image Generation

| Tool | Description |
|------|-------------|
| `flow_generate_image` | Generate image with **Nano Banana 2.1**, **Nano Banana Pro**, or **Nano Banana 2 Lite**. Supports aspect ratios, reference images, and brand-based model selection. |
| `flow_download_latest` | Download the most recently generated file |

### 🎬 Video Generation

| Tool | Description |
|------|-------------|
| `flow_generate_video` | Set up video generation (Omni 1.1 Flash with 4/6/8/10 s, or Veo 3.1 Lite/Fast/Quality at fixed length). ⚠️ **Stops at "ready to generate" — no credit consumed.** |
| `flow_create_scene` | Create a video scene with characters and a text prompt |

### 👤 Characters

| Tool | Description |
|------|-------------|
| `flow_create_character` | Create a new character with name, description, and optional reference images |
| `flow_import_character` | Import a character from a saved JSON file |
| `flow_open_characters` | Open the characters page and list all existing characters |

### 🛠️ Tools & Discovery

| Tool | Description |
|------|-------------|
| `flow_open_tools_gallery` | Open the tools gallery and browse available tools |
| `flow_use_tool` | Open any Flow tool by name with optional parameters |
| `flow_use_grid_architect` | Configure Grid Architect for batch shot generation with theme prompts, visual logic, and reference images |
| `flow_discover_ui` | Discover and map all interactive elements (buttons, inputs, headings) on any Flow page |

### 📊 Queue & Monitoring

| Tool | Description |
|------|-------------|
| `flow_queue_status` | Check job queue: active job, pending queue, completed and failed history |

---

## ⚙️ Configuration

Edit `config/flow.config.json` (copy from `config/flow.config.example.json`):

### 🔑 Essential

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `expectedAccount` | `string` | — | Your Google account email ✅ **REQUIRED** |
| `chromeProfile` | `string` | `"Profile 1"` | Chrome profile directory name — only used once, to seed the persistent profile (see setup step 4) |
| `chromeUserDataDir` | `string` | — | Full path to Chrome user data directory ✅ **REQUIRED** |
| `flowUrl` | `string` | *Flow labs URL* | Google Flow URL (supports `fr`, `en` locales) |

### 🔧 Advanced

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `cdpPort` | `number` | `9222` | Chrome DevTools Protocol port |
| `browserMode` | `string` | `"direct-cdp"` | `"direct-cdp"` (recommended) or `"playwright"` |
| `headless` | `boolean` | `false` | True Chrome headless. Fastest, but Flow's generate/upscale actions are reCAPTCHA-gated and headless scores worse on bot-detection — not recommended for anything that spends credits. |
| `virtualDisplay` | `boolean` | `false` | Run headed Chrome on an off-screen Xvfb display (`xvfb` package required) instead of your real screen — same rendering fingerprint/bot-detection profile as a normal visible window, but doesn't take over your mouse/keyboard/focus. Recommended over `headless` for unattended use once the profile is already authenticated (see setup step 4). |
| `locale` | `string` | `"fr"` | UI locale (`"fr"`, `"en"`, etc.) |

### ⏱️ Timing

| Key | Default | Description |
|-----|---------|-------------|
| `jobTimeoutMs` | `300000` (5 min) | Max job execution time |
| `actionDelayMs` | `800` | Delay between UI actions (anti-detection) |
| `generationPollIntervalMs` | `5000` (5s) | How often to poll for generation completion |
| `maxPollAttempts` | `120` | Max polling attempts before timeout |
| `downloadWaitMs` | `30000` (30s) | Wait time for file download |

### 🎨 Models & Ratios

| Key | Description |
|-----|-------------|
| `imageModels` | Available models: `Nano Banana 2.1`, `Nano Banana Pro`, `Nano Banana 2 Lite` |
| `videoModels` | Available models: `Omni 1.1 Flash`, `Veo 3.1 - Lite/Fast/Quality` |
| `ratios` | Supported aspect ratios: `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |

---

## 🛡️ Safety & Ethics

This project is built with **safety-first design**:

| ✅ Principle | How it's enforced |
|-------------|-------------------|
| **Your account only** | Uses your own Google profile — never asks for or stores passwords |
| **No credential theft** | Never exports cookies, tokens, or session data |
| **No bypass** | Stops cleanly on captcha, login walls, or verification challenges |
| **No parallel abuse** | Single-job queue prevents concurrent generation |
| **Credit-safe video** | Video generation sets up parameters but stops before the final "Generate" click (no credit consumed) |
| **Config backup** | Backs up OpenCode config before any modification |

> ⚠️ **This is a browser automation tool.** Use it responsibly and in accordance with Google's Terms of Service.

---

## ❓ FAQ

### Getting Started

<details>
<summary><strong>Which Chrome profile should I use?</strong></summary>

Open Chrome and go to `chrome://version/`. The **Profile Path** shows both your user data directory and profile name. For example:
- `/home/you/.config/google-chrome/Profile 1` → `chromeUserDataDir: "/home/you/.config/google-chrome"`, `chromeProfile: "Profile 1"`

This is only used once, to seed the MCP's own persistent copy — you don't need to already be signed into Flow in this profile. The first `flow_connect` call walks you through sign-in interactively (see setup step 4).
</details>

<details>
<summary><strong>Can I use this without OpenCode?</strong></summary>

Yes! Any MCP-compatible client (Claude Desktop, Continue.dev, etc.) can connect to this server. Just point your MCP config to `node /path/to/src/index.js`.
</details>

### Troubleshooting

<details>
<summary><strong>Chrome doesn't start</strong></summary>

Make sure Chrome is installed at the expected path. On Linux, the default is `/opt/google/chrome/chrome`. Edit `scripts/start-browser.sh` to set the correct `CHROME` path for your system.
</details>

<details>
<summary><strong>CDP port already in use</strong></summary>

The script checks for existing Chrome instances on port 9222. If something else is using that port, you can change `cdpPort` in `config/flow.config.json` (and update the script's `CDP_PORT` variable).
</details>

<details>
<summary><strong>"Expected account mismatch"</strong></summary>

Verify that `expectedAccount` in `config/flow.config.json` matches the email logged into your Chrome profile. Use `flow_account_check` to verify.
</details>

<details>
<summary><strong>Flow UI changed and tools don't work</strong></summary>

Run `flow_discover_ui` to re-map selectors. The `selectors.map.json` will auto-update with new UI element positions.
</details>

### Usage

<details>
<summary><strong>How do I generate images?</strong></summary>

Your AI agent calls `flow_generate_image` with a text prompt. Optionally specify model (`Nano Banana 2.1` is default), aspect ratio, and reference images. The server waits for completion and makes the file available for download.
</details>

<details>
<summary><strong>Can I generate videos for free?</strong></summary>

`flow_generate_video` sets up the video parameters (model, ratio, duration) but **stops before clicking Generate**. This lets you review the setup before consuming credits. The actual generation requires a paid Google Flow subscription.
</details>

---

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## 📄 License

[MIT](./LICENSE) © TMSSS05

---

<div align="center">
  <sub>Built with ❤️ for the OpenCode ecosystem</sub>
  <br>
  <sub>
    <a href="https://github.com/TMSSS05/google-flow-browser-mcp/issues">Report Issue</a> ·
    <a href="https://github.com/TMSSS05/google-flow-browser-mcp/discussions">Discussion</a>
  </sub>
</div>
