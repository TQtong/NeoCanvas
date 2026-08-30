<#
.SYNOPSIS
Builds and starts NeoCanvas with Docker Compose.

.DESCRIPTION
Creates .env.docker interactively on first run, validates the public Supabase
configuration, starts the production container, and waits for its health check.
#>
[CmdletBinding()]
param(
  [string]$EnvironmentFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectDirectory = $PSScriptRoot
$environmentPath = if ([string]::IsNullOrWhiteSpace($EnvironmentFile)) {
  Join-Path $projectDirectory '.env.docker'
} elseif ([IO.Path]::IsPathRooted($EnvironmentFile)) {
  $EnvironmentFile
} else {
  Join-Path $projectDirectory $EnvironmentFile
}
Set-Location -LiteralPath $projectDirectory

function Write-DockerEnvironment {
  Write-Host 'First deployment: enter the public Supabase settings.' -ForegroundColor Cyan
  $supabaseUrl = (Read-Host 'NEXT_PUBLIC_SUPABASE_URL').Trim()
  $supabaseAnonKey = (Read-Host 'NEXT_PUBLIC_SUPABASE_ANON_KEY').Trim()
  $siteUrlInput = (Read-Host 'NEXT_PUBLIC_SITE_URL [http://localhost:3100]').Trim()
  $siteUrl = if ($siteUrlInput) { $siteUrlInput } else { 'http://localhost:3100' }
  $imageEditingInput = (Read-Host 'Enable precision image editing? [y/N]').Trim()
  $imageEditingEnabled = if ($imageEditingInput -match '^(y|yes)$') { 'true' } else { 'false' }

  $parsedSupabaseUrl = $null
  if (-not [Uri]::TryCreate($supabaseUrl, [UriKind]::Absolute, [ref]$parsedSupabaseUrl)) {
    throw 'NEXT_PUBLIC_SUPABASE_URL must be an absolute URL.'
  }
  $isLocalSupabase = $parsedSupabaseUrl.Host -in @('localhost', '127.0.0.1')
  if ($parsedSupabaseUrl.Scheme -ne 'https' -and -not ($isLocalSupabase -and $parsedSupabaseUrl.Scheme -eq 'http')) {
    throw 'NEXT_PUBLIC_SUPABASE_URL must use https, except for localhost / 127.0.0.1.'
  }
  if (-not $supabaseAnonKey -or $supabaseAnonKey -eq 'your-anon-public-key') {
    throw 'NEXT_PUBLIC_SUPABASE_ANON_KEY is required.'
  }

  $parsedSiteUrl = $null
  if (-not [Uri]::TryCreate($siteUrl, [UriKind]::Absolute, [ref]$parsedSiteUrl)) {
    throw 'NEXT_PUBLIC_SITE_URL must be an absolute URL.'
  }

  $lines = @(
    "NEXT_PUBLIC_SUPABASE_URL=$supabaseUrl",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY=$supabaseAnonKey",
    "NEXT_PUBLIC_SITE_URL=$siteUrl",
    "NEXT_PUBLIC_IMAGE_EDITING_ENABLED=$imageEditingEnabled",
    'NEOCANVAS_PORT=3100'
  )
  if ($parsedSupabaseUrl.Host -in @('localhost', '127.0.0.1')) {
    $lines += "SUPABASE_INTERNAL_URL=$($parsedSupabaseUrl.Scheme)://host.docker.internal:$($parsedSupabaseUrl.Port)"
  }
  [IO.File]::WriteAllLines($environmentPath, $lines, [Text.UTF8Encoding]::new($false))
  Write-Host "Created $environmentPath" -ForegroundColor Green
}

function Get-DockerEnvironmentValue {
  param([Parameter(Mandatory)][string]$Name)

  $prefix = "$Name="
  $line = Get-Content -LiteralPath $environmentPath | Where-Object { $_.StartsWith($prefix) } | Select-Object -Last 1
  if (-not $line) { return '' }
  return $line.Substring($prefix.Length).Trim()
}

if (-not (Test-Path -LiteralPath $environmentPath)) {
  Write-DockerEnvironment
}

$requiredVariables = @('NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SITE_URL')
foreach ($variable in $requiredVariables) {
  $value = Get-DockerEnvironmentValue -Name $variable
  if (-not $value -or $value -match '^your-|<.+>$') {
    throw "$variable is missing or still contains a placeholder in $environmentPath."
  }
}

$imageEditingEnabled = Get-DockerEnvironmentValue -Name 'NEXT_PUBLIC_IMAGE_EDITING_ENABLED'
if ($imageEditingEnabled -and $imageEditingEnabled -notin @('true', 'false')) {
  throw 'NEXT_PUBLIC_IMAGE_EDITING_ENABLED must be true or false.'
}

# 兼容既有 .env.local / .env.docker：本地 Supabase 对浏览器与容器需要不同主机名。
$publicSupabaseUrl = ''
$configuredInternalUrl = ''
$publicSupabaseUrl = Get-DockerEnvironmentValue -Name 'NEXT_PUBLIC_SUPABASE_URL'
$configuredInternalUrl = Get-DockerEnvironmentValue -Name 'SUPABASE_INTERNAL_URL'
$publicSupabaseUri = [Uri]$publicSupabaseUrl
if ($configuredInternalUrl) {
  $env:SUPABASE_INTERNAL_URL = $configuredInternalUrl
} elseif ($publicSupabaseUri.Host -in @('localhost', '127.0.0.1')) {
  $env:SUPABASE_INTERNAL_URL = "$($publicSupabaseUri.Scheme)://host.docker.internal:$($publicSupabaseUri.Port)"
} else {
  $env:SUPABASE_INTERNAL_URL = ''
}

& docker version *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker is not available. Start Docker Desktop and run this script again.'
}
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Compose v2 is required.'
}

Write-Host 'Building and starting NeoCanvas...' -ForegroundColor Cyan
& docker compose --env-file $environmentPath up --detach --build --remove-orphans
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Compose failed to start NeoCanvas.'
}

$containerId = (& docker compose --env-file $environmentPath ps --quiet web).Trim()
if (-not $containerId) {
  throw 'NeoCanvas container was not created.'
}

$healthy = $false
for ($attempt = 1; $attempt -le 60; $attempt++) {
  $health = (& docker inspect --format '{{.State.Health.Status}}' $containerId 2>$null).Trim()
  if ($health -eq 'healthy') {
    $healthy = $true
    break
  }
  if ($health -eq 'unhealthy') {
    break
  }
  Start-Sleep -Seconds 2
}

if (-not $healthy) {
  & docker compose --env-file $environmentPath logs --tail 100 web
  throw 'NeoCanvas did not become healthy. The latest container logs are shown above.'
}

$siteUrl = Get-DockerEnvironmentValue -Name 'NEXT_PUBLIC_SITE_URL'
Write-Host "NeoCanvas is healthy: $siteUrl" -ForegroundColor Green
& docker compose --env-file $environmentPath ps
