# Custom Domain Setup Guide

> Sprint 7 — Setting up a professional custom domain for the Autonomous Paper Trading Agent dashboard.

---

## Problem

The current domain `ai-quant-trader.duckdns.org` is functional but has limitations:

- **Trust warnings** — Some browsers and corporate environments flag `.duckdns.org` subdomains as potentially suspicious dynamic DNS.
- **Professional appearance** — A `.duckdns.org` suffix looks less polished for a Kaggle Capstone submission compared to a real domain.
- **Firewall restrictions** — Some corporate and academic firewalls block dynamic DNS domains entirely, which could prevent judges from accessing the demo.

---

## Solution

Use **Cloudflare (free tier)** with a purchased domain for:

| Benefit | Details |
|---|---|
| Professional URL | `yourdomain.com` instead of `ai-quant-trader.duckdns.org` |
| Free SSL/TLS | Full (Strict) mode with automatic HTTPS |
| DDoS protection | Cloudflare proxy shields the VPS IP |
| CDN caching | Static assets served from edge nodes |
| Simple DNS | Easy management through Cloudflare dashboard |

---

## Prerequisites

- [ ] A registered domain (~$10/year)
- [ ] A Cloudflare account (free tier is sufficient)
- [ ] SSH access to the VPS (`138.2.186.85`)
- [ ] Nginx installed on the VPS

---

## Step-by-Step Setup

### Step 1: Buy a Domain

Choose a registrar and purchase a domain. Approximate costs:

| Registrar | Price (approx.) | Notes |
|---|---|---|
| Cloudflare Registrar | $8–12/year | At-cost pricing, integrates directly |
| Porkbun | $5–10/year | Cheap `.dev`, `.ai` domains |
| Namecheap | $8–12/year | Frequent sales |
| Google Domains | $12/year | Reliable, simple |

**Suggested domain names:**
- `quantagent.dev`
- `papertrader.ai`
- `ai-trader.dev`
- `autonomous-trader.com`
- `[yourname]-quant.dev`

> 💡 **Tip:** `.dev` domains enforce HTTPS by default (HSTS preloaded), which is ideal for this project.

---

### Step 2: Add Domain to Cloudflare

1. Sign up or log in at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Click **"Add a Site"** and enter your domain
3. Select the **Free** plan
4. Cloudflare will provide two nameservers (e.g., `anna.ns.cloudflare.com`, `brad.ns.cloudflare.com`)
5. Go to your domain registrar and **update the nameservers** to the ones Cloudflare provided
6. Wait for propagation — usually 15–60 minutes, occasionally up to 24 hours
7. Cloudflare will email you when the domain is active

---

### Step 3: Create DNS Records

In the Cloudflare DNS dashboard, create these records:

| Type | Name | Content | Proxy | TTL |
|---|---|---|---|---|
| A | `@` | `138.2.186.85` | ✅ Proxied (orange cloud) | Auto |
| A | `www` | `138.2.186.85` | ✅ Proxied (orange cloud) | Auto |
| CNAME | `api` | `@` | ✅ Proxied (optional) | Auto |

> ⚠️ **Important:** Keep proxy enabled (orange cloud) to hide the VPS IP and get DDoS protection.

---

### Step 4: Configure Cloudflare SSL

Navigate to **SSL/TLS** in the Cloudflare dashboard:

1. **Overview** → Set encryption mode to **Full (Strict)**
2. **Edge Certificates**:
   - ✅ Always Use HTTPS → **On**
   - ✅ Automatic HTTPS Rewrites → **On**
   - Minimum TLS Version → **TLS 1.2**
   - ✅ TLS 1.3 → **On**
3. **HSTS** (optional but recommended):
   - Enable HSTS with `max-age=31536000`
   - Include subdomains

---

### Step 5: Generate Cloudflare Origin Certificate

For **Full (Strict)** mode, you need an origin certificate on the VPS:

1. In Cloudflare dashboard → **SSL/TLS** → **Origin Server**
2. Click **Create Certificate**
3. Use Cloudflare-generated private key (RSA 2048)
4. Hostnames: `yourdomain.com`, `*.yourdomain.com`
5. Validity: **15 years** (recommended — no renewal needed)
6. Copy the **Origin Certificate** and **Private Key**

On the VPS:

```bash
# Create certificate directory
sudo mkdir -p /etc/ssl/cloudflare

# Paste the origin certificate
sudo nano /etc/ssl/cloudflare/origin.pem
# (Paste the certificate content, save)

# Paste the private key
sudo nano /etc/ssl/cloudflare/origin-key.pem
# (Paste the key content, save)

# Secure the key file
sudo chmod 600 /etc/ssl/cloudflare/origin-key.pem
sudo chmod 644 /etc/ssl/cloudflare/origin.pem
```

---

### Step 6: Update Nginx on VPS

SSH into the VPS and update the Nginx configuration:

```bash
ssh -i your-key.pem ubuntu@138.2.186.85
sudo nano /etc/nginx/sites-available/quant-trader
```

**Nginx configuration:**

```nginx
# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name yourdomain.com www.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

# Main HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;

    # Cloudflare Origin Certificate
    ssl_certificate     /etc/ssl/cloudflare/origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare/origin-key.pem;

    # SSL settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Proxy to Next.js dashboard
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Timeouts for WebSocket-like connections
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
```

Enable and test:

```bash
# Create symlink (if not exists)
sudo ln -sf /etc/nginx/sites-available/quant-trader /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

---

### Step 7: Alternative — Certbot / Let's Encrypt

If you prefer **not** to use Cloudflare proxy (grey cloud / DNS-only mode), use Certbot for free certificates:

```bash
# Install Certbot
sudo apt update
sudo apt install -y certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# Auto-renewal is set up automatically
# Verify with:
sudo certbot renew --dry-run
```

> ⚠️ **Note:** Certbot requires DNS-only mode (grey cloud) in Cloudflare, or direct DNS pointing. It cannot issue certificates when Cloudflare proxy is enabled (because the ACME challenge connects to Cloudflare, not your VPS).

---

## Multiple Subdomains (Optional)

If you want separate subdomains for different services:

| Subdomain | Purpose | Target |
|---|---|---|
| `yourdomain.com` | Main dashboard | `localhost:3000` |
| `api.yourdomain.com` | API endpoints | `localhost:3000` |
| `mcp.yourdomain.com` | MCP server (if exposed via HTTP) | `localhost:4000` |

Add DNS records in Cloudflare for each subdomain, then add separate Nginx server blocks:

```nginx
server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate     /etc/ssl/cloudflare/origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare/origin-key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Update Project References

After setting up the custom domain, update these files:

- [ ] `README.md` — replace `ai-quant-trader.duckdns.org` with new domain
- [ ] `kaggle/KAGGLE_README_UPGRADE.md` — update Live Demo URL
- [ ] `kaggle/KAGGLE_WRITEUP_DRAFT.md` — update all URLs
- [ ] `kaggle/KAGGLE_VIDEO_SCRIPT.md` — update on-screen URLs
- [ ] `kaggle/SUBMISSION_ASSETS.md` — update project links
- [ ] `.env` / `.env.local` — update any hardcoded URLs (e.g., `STATUS_URL`)
- [ ] `.github/workflows/` — update deploy verification URLs
- [ ] `scripts/vps-deploy-check.sh` — update default URL

---

## Verification

After setup, verify everything works:

```bash
# Check HTTP redirect
curl -I http://yourdomain.com
# Expected: 301 redirect to https://

# Check HTTPS
curl -I https://yourdomain.com
# Expected: 200 OK with Cloudflare headers

# Check DNS resolution
nslookup yourdomain.com
# Expected: Cloudflare IP (not 138.2.186.85 — because proxy is enabled)

# Check SSL certificate
openssl s_client -connect yourdomain.com:443 -servername yourdomain.com 2>/dev/null | openssl x509 -noout -subject -issuer
# Expected: Cloudflare-issued edge certificate

# Check from the VPS
curl -I --resolve yourdomain.com:443:127.0.0.1 https://yourdomain.com
# (may need to use localhost directly)
```

---

## Rollback

If anything goes wrong:

1. The **DuckDNS domain remains active** — `ai-quant-trader.duckdns.org` continues to work independently
2. Remove the custom domain from Cloudflare
3. Revert Nginx to the previous configuration
4. All project references can use the DuckDNS URL

> 💡 Keep the DuckDNS domain running as a backup even after setting up the custom domain.

---

## Cost Summary

| Item | Cost |
|---|---|
| Domain registration | ~$10/year |
| Cloudflare (free tier) | $0 |
| Cloudflare Origin Certificate | $0 (15-year validity) |
| Oracle VPS | $0 (free tier) |
| **Total** | **~$10/year** |

---

> ⚠️ This guide is for the Autonomous Paper Trading Agent — an educational simulation. It does not provide financial advice.
