param([Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference = "Stop"
if (-not $env:DATABASE_URL) { throw "DATABASE_URL is required." }
pg_restore --clean --if-exists --no-owner --no-acl --dbname=$env:DATABASE_URL $InputFile
Write-Output "Restore completed from $InputFile"
