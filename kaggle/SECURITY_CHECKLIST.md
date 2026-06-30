# Pre-Submission Security Audit Checklist

> Sprint 8 — Ensure no secrets, credentials, or private keys are exposed before submitting to the Kaggle AI Agents Capstone.

---

## Purpose

Before submitting to the Kaggle AI Agents Capstone, this checklist ensures the repository, live demo, and all documentation are free of sensitive information. **Every item must be verified and checked off.**

---

## 1. Secrets & Credentials

- [ ] No `.env` file committed to git
- [ ] No `.env.local` file committed to git
- [ ] No `.env.production` file committed to git
- [ ] No API keys (Gemini, Groq, OpenRouter, Binance, Bybit) in source code
- [ ] No API keys in README or any documentation file
- [ ] No admin passwords or admin tokens in README or documentation
- [ ] No database credentials in source code
- [ ] No Telegram bot tokens in source code
- [ ] `.env.local.example` contains only placeholder values — no real keys

---

## 2. SSH Keys

- [ ] No SSH private keys committed to git
- [ ] No SSH public keys committed to git
- [ ] No files matching: `ssh-key-*`, `*.key`, `*.pem`, `id_rsa`, `id_ed25519`
- [ ] No SSL/TLS certificates or private keys committed

---

## 3. Authentication & Authorization

- [ ] Spectator mode (`Bearer SPECTATOR`) cannot open trades
- [ ] Spectator mode cannot close trades
- [ ] Spectator mode cannot modify positions
- [ ] Spectator mode cannot reset portfolio
- [ ] Spectator mode cannot trigger manual trades
- [ ] Reset endpoints require admin authentication
- [ ] Manual trade endpoints require admin authentication
- [ ] Admin secret is loaded from environment variables — not hardcoded in source
- [ ] Admin token is not visible in any public documentation

---

## 4. Read-Only Components

- [ ] MCP server (`mcp/trading_mcp_server.ts`) is read-only — no write operations exposed
- [ ] ADK reviewer agent (`agents/trading_reviewer_agent.py`) is read-only — no mutations
- [ ] Agent CLI scripts (`agent:status`, `agent:explain`, `agent:audit`) are read-only
- [ ] Strategy audit script does not modify live state

---

## 5. Public Dashboard

- [ ] Public demo does not require login
- [ ] Public demo displays only read-only data
- [ ] No API keys, tokens, or secrets visible in the dashboard UI
- [ ] No admin endpoints accessible without authentication
- [ ] Browser developer tools (Network tab) do not expose sensitive headers

---

## 6. Paper Trading Safety

- [ ] `LIVE_TRADING_ENABLED` defaults to `false`
- [ ] No path exists to execute real trades without explicitly changing environment variables
- [ ] README clearly states "paper trading only"
- [ ] Safety disclaimer present in README, writeup, and video script
- [ ] No real brokerage connection in production configuration

---

## ⚠️ Known Issues to Address

> **These issues were identified in the repository and MUST be resolved before submission.**

### Issue 1: SSH Keys in Repository Root

The following files are present in the repository root:

```
ssh-key-2026-05-31.key        (PRIVATE KEY — CRITICAL)
ssh-key-2026-05-31.key.pub    (PUBLIC KEY)
```

**Impact:** The SSH private key provides direct access to the VPS. If committed to git history, anyone who clones the repository can access the server.

**Remediation:**

1. **Remove the files immediately:**
   ```bash
   git rm ssh-key-2026-05-31.key ssh-key-2026-05-31.key.pub
   git commit -m "security: remove SSH keys from repository"
   ```

2. **Add to `.gitignore`:**
   ```
   *.key
   *.key.pub
   *.pem
   ssh-key-*
   id_rsa
   id_ed25519
   ```

3. **Rotate the keys** — these keys are compromised if they were ever in git history:
   ```bash
   # Generate new SSH key pair
   ssh-keygen -t ed25519 -C "vps-deploy" -f ~/.ssh/vps-deploy-key

   # Copy new public key to VPS (using old key while it still works)
   ssh-copy-id -i ~/.ssh/vps-deploy-key.pub ubuntu@138.2.186.85

   # Remove old key from VPS authorized_keys
   ssh ubuntu@138.2.186.85 "nano ~/.ssh/authorized_keys"
   # Delete the line matching the old key

   # Update GitHub Actions secrets with new key
   ```

4. **Clean git history** (see Remediation Steps below)

---

### Issue 2: Environment Files in Repository

The files `.env` and `.env.local` are present in the repository root. These typically contain:

- Redis credentials
- API keys (Gemini, Groq, OpenRouter)
- Admin secrets
- Exchange API keys (Binance, Bybit)
- Telegram bot tokens

**Remediation:**

1. **Remove from tracking:**
   ```bash
   git rm --cached .env .env.local
   git commit -m "security: remove environment files from tracking"
   ```

2. **Verify `.gitignore` includes:**
   ```
   .env
   .env.local
   .env.production
   .env*.local
   ```

3. **Rotate all exposed secrets:**
   - Generate new `DASHBOARD_SECRET` and `ADMIN_SECRET`
   - Rotate any API keys that were in the files
   - Update `.env` on the VPS (not in git)

---

## Repository Scan Commands

Run these commands to verify the repository is clean:

### Check for committed secrets in current tree

```bash
# List any sensitive files currently tracked
git ls-files | grep -iE '\.(env|key|pem)$|ssh-key|id_rsa|id_ed25519'
```

### Check git history for past commits of sensitive files

```bash
# Check if .env files were ever committed
git log --all --diff-filter=A -- '.env' '.env.local' '.env.production'

# Check if SSH keys were ever committed
git log --all --diff-filter=A -- 'ssh-key-*' '*.key' '*.pem' 'id_rsa' 'id_ed25519'
```

### Search source code for hardcoded secrets

```bash
# Search for common secret patterns in source files
git grep -inE 'api_key|api_secret|password|private_key|secret_key|bearer\s+[a-zA-Z0-9]{20,}' \
  -- '*.ts' '*.tsx' '*.js' '*.py' '*.json' ':!package-lock.json' ':!node_modules'
```

### Verify .gitignore coverage

```bash
# Check that sensitive patterns are in .gitignore
echo "=== .gitignore contents ==="
cat .gitignore

echo ""
echo "=== Checking for sensitive patterns ==="
for pattern in ".env" ".env.local" "*.key" "*.pem" "ssh-key"; do
  if grep -q "$pattern" .gitignore; then
    echo "✅ $pattern is in .gitignore"
  else
    echo "❌ $pattern is MISSING from .gitignore"
  fi
done
```

---

## Remediation: Cleaning Git History

If sensitive files were committed to git history, they remain accessible even after deletion. Use one of these methods:

### Option 1: BFG Repo Cleaner (Recommended)

```bash
# Download BFG
# https://rtyley.github.io/bfg-repo-cleaner/

# Remove sensitive files from all history
java -jar bfg.jar --delete-files '.env' .
java -jar bfg.jar --delete-files '.env.local' .
java -jar bfg.jar --delete-files '*.key' .

# Clean up
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# Force push (WARNING: rewrites history for all collaborators)
git push --force
```

### Option 2: git filter-repo (Modern Alternative)

```bash
# Install git-filter-repo
pip install git-filter-repo

# Remove specific files from history
git filter-repo --invert-paths \
  --path .env \
  --path .env.local \
  --path ssh-key-2026-05-31.key \
  --path ssh-key-2026-05-31.key.pub

# Force push
git push --force
```

### Option 3: git filter-branch (Legacy)

```bash
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch .env .env.local ssh-key-*.key ssh-key-*.key.pub' \
  --prune-empty --tag-name-filter cat -- --all

git reflog expire --expire=now --all
git gc --prune=now --aggressive
git push --force
```

---

## Post-Remediation Checklist

After cleaning secrets:

- [ ] All exposed API keys have been rotated
- [ ] New SSH keys have been generated
- [ ] VPS `authorized_keys` has been updated with new keys
- [ ] Old SSH keys have been removed from VPS
- [ ] `.env` files on VPS have been updated with new secrets
- [ ] GitHub Actions secrets have been updated with new SSH key
- [ ] `.gitignore` includes all sensitive file patterns
- [ ] `git ls-files` shows no sensitive files
- [ ] `git log --all` search confirms no sensitive files in history (after filter)

---

## Recommended .gitignore Additions

Ensure these patterns are in your `.gitignore`:

```gitignore
# Environment files
.env
.env.local
.env.production
.env.development
.env*.local

# SSH and security keys
*.key
*.key.pub
*.pem
ssh-key-*
id_rsa
id_ed25519
id_rsa.pub
id_ed25519.pub

# Certificates
*.crt
*.cert
origin.pem
origin-key.pem

# OS and editor
.DS_Store
Thumbs.db
*.swp
*.swo
*~
```

---

## Final Sign-Off

- [ ] All items in sections 1–6 have been verified
- [ ] Known issues (SSH keys, .env files) have been remediated
- [ ] Git history has been cleaned (if applicable)
- [ ] All exposed secrets have been rotated
- [ ] Repository is safe for public submission
- [ ] Live demo does not expose sensitive information

**Date:** ____________  
**Reviewer:** ____________  
**Status:** ⬜ PASS / ⬜ FAIL

---

> ⚠️ This project is an educational paper-trading simulation. It does not execute real-money trades and does not provide financial advice.
