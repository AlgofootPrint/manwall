param(
  [string]$Output = "backups/manwall-$(Get-Date -Format 'yyyyMMdd-HHmmss').dump"
)
$ErrorActionPreference = "Stop"
if (-not $env:DATABASE_URL) { throw "DATABASE_URL is required." }
$directory = Split-Path -Parent $Output
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
pg_dump --format=custom --no-owner --no-acl --file=$Output $env:DATABASE_URL
Write-Output "Backup written to $Output"
