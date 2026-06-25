# Nomyx — server deployment

The server runs as a single Node process that serves both the API and the built
web UI on one port (default **4433**). There is no separate web server or Vite
process in production.

## Build and run

```bash
npm install          # first time only
npm run build        # builds the React UI into ./dist
npm start            # runs the server, serving the API + the built UI
```

Open `http://localhost:4433`. The default admin login is created on first run
(`admin@nomyx.local` / `admin`) — change it immediately.

If `./dist` doesn't exist (you haven't built), the server still runs but serves
the API only — that's the development mode where you run `npm run client`
(Vite) separately.

## HTTPS

HTTPS turns on automatically when you point the server at a certificate and key
via environment variables:

```bash
TLS_CERT=/path/to/cert.pem TLS_KEY=/path/to/key.pem npm start
# → Nomyx running on https://localhost:4433
```

When TLS is active the session cookie is automatically marked `secure`. If
either variable is missing or the file isn't found, the server falls back to
plain HTTP.

### Getting a certificate

- **Production:** use a cert from your internal CA or a commercial provider.
  Just point `TLS_CERT` / `TLS_KEY` at the PEM files.
- **Internal / lab (self-signed):** run `node gen-cert.mjs` (needs openssl;
  available on Linux/macOS/WSL/Raspberry Pi). It writes `cert.pem` and `key.pem`.
- **Native Windows without openssl:** generate one in PowerShell:

  ```powershell
  $c = New-SelfSignedCertificate -DnsName "localhost" -CertStoreLocation Cert:\CurrentUser\My
  # then export $c to cert.pem / key.pem, or run gen-cert.mjs inside WSL
  ```

## Behind a reverse proxy / load balancer

If your environment terminates TLS at a proxy (nginx, Caddy, an F5, etc.), leave
`TLS_CERT` / `TLS_KEY` unset so Nomyx serves plain HTTP, and let the proxy handle
HTTPS and forward to port 4433.

## Docker

A multi-stage `Dockerfile` and `docker-compose.yml` are included. The image builds
the UI, compiles the native deps, and runs the server with the SQLite database on a
named volume so data survives restarts and rebuilds.

```bash
docker compose up -d --build
```

Nomyx is then on `http://localhost:4433`. Set `SESSION_SECRET` in `docker-compose.yml`
(or your orchestrator's secrets) before any real use. Docker also sidesteps the
Windows `.env` BOM issue entirely, since env vars are passed directly.

Data lives in the `nomyx-data` volume at `/data/nomyx.db`. To terminate TLS in the
container, mount your cert/key and set `TLS_CERT`/`TLS_KEY`; behind a proxy, set
`TRUST_PROXY` and leave TLS to the proxy.

## Monitoring Docker stats

The agent runs shell commands from its `config.json`, so monitoring Docker is
configuration, not code -- add checks that call `docker`. The agent needs Docker
access: run it on the Docker host (as a user in the `docker` group), or, if the
agent itself runs in a container, mount the socket
(`-v /var/run/docker.sock:/var/run/docker.sock`) and include the docker CLI.

Example checks in `config.json`:

```json
{ "name": "running_containers", "command": "docker ps -q | wc -l", "unit": "count", "warn": 1, "crit": 0, "thresholdDir": "below" },
{ "name": "pihole_cpu_pct",     "command": "docker stats --no-stream --format \"{{.CPUPerc}}\" pihole | tr -d '%'", "unit": "%", "warn": 70, "crit": 90 },
{ "name": "pihole_mem_pct",     "command": "docker stats --no-stream --format \"{{.MemPerc}}\" pihole | tr -d '%'", "unit": "%", "warn": 80, "crit": 90 }
```

`running_containers` flags when the count drops (thresholdDir `below`); the CPU and
memory checks watch a named container.

## Agents

Agents are standalone binaries — **no Node.js required on the monitored host**.
Build them once on your dev machine:

```bash
npm install            # first time (pulls esbuild + pkg)
npm run agent:binaries # → dist-agent/nomyx-agent-linux-x64
                       #   dist-agent/nomyx-agent-win-x64.exe
                       #   dist-agent/nomyx-agent-linux-arm64   (Raspberry Pi)
```

Each host needs the right binary plus a `config.json` (server URL, token, and the
checks to run). For HTTPS servers using a self-signed or internal cert, add
`"caCertPath": "ca.pem"` to trust your CA, or `"insecureTLS": true` for lab use.

### Linux (systemd)

Copy the matching binary, your `config.json`, `nomyx-agent.service`, and
`install.sh` to the host, then:

```bash
chmod +x install.sh && ./install.sh
```

It auto-detects the architecture, installs to `/opt/nomyx-agent`, and registers a
service that starts on boot and restarts on failure. Logs: `journalctl -u nomyx-agent -f`.

### Windows (scheduled task)

Copy `nomyx-agent-win-x64.exe`, your `config.json`, and `install.ps1` to the host,
then in an **elevated** PowerShell:

```powershell
.\install.ps1
```

It installs to `C:\Program Files\Nomyx Agent` and registers a SYSTEM scheduled
task that runs at startup and restarts on failure. Uninstall with
`Unregister-ScheduledTask -TaskName NomyxAgent -Confirm:$false`.

### Docker / Unraid

Because an Unraid host's OS runs from RAM, a host-installed service or binary does
**not** survive a reboot — so run the agent as a container instead. Build it from
`Dockerfile.agent` and mount your config plus the Docker socket:

```bash
docker build -f Dockerfile.agent -t nomyx-agent .
docker run -d --name nomyx-agent \
  -v /mnt/user/appdata/nomyx-agent:/config \
  -v /var/run/docker.sock:/var/run/docker.sock \
  nomyx-agent
```

The container survives reboots (Docker config persists on appdata), and the
mounted socket lets it run `docker` checks against the host's containers.
