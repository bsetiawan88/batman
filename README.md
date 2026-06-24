# BATMAN — Browser Automation Test Manager And Navigator

YAML-driven browser automation for E2E testing and web automation. Runs on **Playwright**.

## Install

```bash
npm install
npx playwright install chromium
```

## Quick Start

```bash
# Basic test (temp browser)
npx tsx src/index.ts run -s scenarios/example.yml -u https://example.com -b chromium --headed -v

# Persistent profile (login once, session survives)
npx tsx src/index.ts run -s scenarios/smoke.yml -u https://mysite.com \
  -b chromium --headed -v --profile ./my-profile

# System Chrome (uses your real Chrome)
npx tsx src/index.ts run -s scenarios/smoke.yml -u https://mysite.com \
  -b chromium --headed -v --profile ./my-profile --channel chrome
```

## CLI Reference

| Flag | Default | Description |
|------|---------|-------------|
| `-s --scenario <path>` | *(required)* | YAML scenario file |
| `-u --url <urls...>` | *(required)* | Target site URL(s) |
| `-b --browser` | `chromium` | `chromium`, `firefox`, `webkit` |
| `-m --mode` | `sequential` | `sequential` or `parallel` |
| `-w --workers` | browser count | Max parallel workers |
| `--headed` | off | Show browser UI |
| `-v --verbose` | off | Detailed step output |
| `--profile <path>` | — | Persistent browser profile |
| `--channel <name>` | — | `chrome`, `msedge` (system browser) |
| `--resolution <W\|H>` | `1280x720` | `720p`, `1080p`, `2k`, `4k`, `1920x1080` |
| `-t --timeout <ms>` | `30000` | Step timeout |
| `-r --retries <n>` | `0` | Retry failed steps |
| `--env-file <path>` | — | Load env from `.env` file |
| `--dry-run` | off | Validate without executing |
| `--clear-cache` | off | Clear cached variable values |
| `--remember-last-option` | off | Skip prompts, use last choices |

## Scenario YAML Reference

```yaml
name: My E2E Test

# Optional env file (loads VAR=value)
env_file: .env

# Scenario variables (resolved from env or prompted)
variables:
  user: "{{env:WP_USER}}"

steps:
  # ── Navigation ──
  - goto: { url: /login }
  - wait: { ms: 1000 }

  # ── Interaction ──
  - fill: { selector: "#user", value: "{{user}}" }
  - fill: { selector: "#pass", value: "{{WP_PASS}}" }
  - click: { selector: "button[type=submit]" }
  - wait: { selector: ".dashboard" }

  # ── Screenshot ──
  - screenshot: { name: dashboard }

  # ── Conditional execution ──
  - when: "{{plan}} == premium"
    click: { selector: ".premium-feature" }

  - when: "{{plan}} in [premium, enterprise]"
    click: { selector: ".advanced-settings" }

  # ── Radio branching (pick one) ──
  - child:
      accept:
        - click: { selector: "button:has-text('Accept')" }
        - wait: { ms: 1000 }
      decline:
        - click: { selector: "button:has-text('Decline')" }

  # ── Checkbox branching (pick multiple) + save to var ──
  - child:
      type: checkbox
      var: features
      on_empty:
        - click: { selector: "button:has-text('Skip')" }
      feature_a:
        - click: { selector: "#enable-a" }
      feature_b:
        - click: { selector: "#enable-b" }

  # ── Post-verification using $var ──
  - when: "$features in [feature_a]"
    assert_visible: { selector: ".feature-a-enabled" }

  # ── Assertions ──
  - assert_visible: { selector: ".success" }
  - assert_text: { text: "Welcome" }
  - assert_url: { url: /dashboard }
  - assert_count: { selector: ".item", count: 5 }
  - assert_value: { selector: "#status", value: "active" }

  # ── Database query ──
  - db_query:
      engine: mysql
      connection: "mysql://user:pass@host:3306/db"
      query: "SELECT * FROM options WHERE name = 'siteurl'"
      save_as: site_info

  # ── API requests ──
  - request:
      method: POST
      url: https://api.example.com/verify
      headers: { Authorization: "Bearer {{TOKEN}}" }
      body: { site: "{{url}}" }
      save_as: api_result

  # ── Evaluate JavaScript ──
  - evaluate:
      script: "(selector) => document.querySelector(selector).click()"
      args: [".dynamic-btn"]

  # ── OAuth Popups ──
  - popup: {}
  - click: { selector: "button:has-text('Sign in with Google')" }
  - popup_wait: {}
  - fill: { selector: "input[type=email]", value: "{{EMAIL}}" }
  - click: { selector: "button:has-text('Next')" }
  - popup_close: {}
```

## Action Reference

| Action | YAML |
|--------|------|
| `goto` | `{ url: /path }` |
| `click` | `{ selector: ".btn", force: true }` |
| `fill` | `{ selector: "#input", value: "text", force: true }` |
| `select` | `{ selector: "select", value: "option" }` |
| `check` / `uncheck` | `{ selector: "#box" }` |
| `press` | `{ key: "Enter" }` |
| `wait` | `{ ms: 1000 }` or `{ selector: ".loaded" }` |
| `screenshot` | `{ name: step-name }` |
| `evaluate` | `{ script: "(sel) => {...}", args: [".btn"] }` |
| `db_query` | `{ engine: mysql, connection: "...", query: "..." }` |
| `request` | `{ method: GET, url: "...", save_as: key }` |
| `assert` | `{ selector: ".el" }` |
| `assert_text` | `{ text: "Welcome" }` |
| `assert_url` | `{ url: /dashboard }` |
| `assert_count` | `{ selector: ".item", count: 5 }` |
| `assert_visible` | `{ selector: ".el" }` |
| `assert_hidden` | `{ selector: ".el" }` |
| `assert_value` | `{ selector: "#input", value: "expected" }` |
| `assert_json` | `{ source: varName, path: "data.id", equals: 1 }` |
| `assert_db` | `{ source: varName, column: "name", equals: "admin" }` |
| `popup` / `popup_wait` / `popup_close` | OAuth popup lifecycle |
| `save_html` | `{ label: debug }` |
| `dialog_accept` | `{ promptText: "text" }` |
| `dialog_dismiss` | `{}` |
| `wait_for_navigation` | `{ url: /path }` |
| `wait_for_network_idle` | `{ timeout: 5000 }` |

## Project Structure

```
├── scenarios/       ← YAML test scenarios
├── src/
│   ├── engine/      ← parser, compiler, variables, assertions
│   ├── runner/      ← worker, orchestrator, artifacts
│   ├── reporter/    ← console, JSON, text output
│   └── tui/         ← terminal UI for branch selection
├── package.json
└── tsconfig.json
```

## Requirements

- Node.js >= 22
- Playwright (`npx playwright install`)
- MySQL 2 (optional, for `db_query`: `npm install mysql2`)
