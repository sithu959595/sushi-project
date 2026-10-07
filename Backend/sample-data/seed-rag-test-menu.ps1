#Requires -Version 5.1

[CmdletBinding()]
param(
  [string]$ApiBaseUrl,

  [string]$MenuPath,

  [string]$TerraformDirectory,

  [string]$TokenEnvironmentVariable = "SUSHI_ADMIN_ID_TOKEN",

  [switch]$Force,

  [switch]$AllowProduction,

  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($MenuPath)) {
  $MenuPath = Join-Path $PSScriptRoot "rag-test-menu.json"
}

if ([string]::IsNullOrWhiteSpace($TerraformDirectory)) {
  $TerraformDirectory = Join-Path $PSScriptRoot "..\terraform"
}

function Resolve-RequiredPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath,

    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  $resolved = Resolve-Path -LiteralPath $LiteralPath -ErrorAction SilentlyContinue
  if (-not $resolved) {
    throw "$Description was not found at '$LiteralPath'."
  }

  return $resolved.Path
}

function Test-MenuPayload {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ResolvedMenuPath
  )

  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    throw "Node.js is required to run the existing menu validator."
  }

  $validatorPath = Resolve-RequiredPath `
    -LiteralPath (Join-Path $PSScriptRoot "..\terraform\lambda\handler\validate-menu.js") `
    -Description "The menu validator"

  $rawMenu = Get-Content -LiteralPath $ResolvedMenuPath -Raw
  $bodyBytes = [Text.Encoding]::UTF8.GetByteCount($rawMenu)
  if ($bodyBytes -gt (64 * 1024)) {
    throw "The menu payload is $bodyBytes bytes and exceeds the 64 KiB API limit."
  }

  $validationProgram = @'
const fs = require("node:fs");

const [menuPath, validatorPath] = process.argv.slice(2);
let payload;

try {
  payload = JSON.parse(fs.readFileSync(menuPath, "utf8"));
} catch (error) {
  console.error(`Could not parse the menu JSON: ${error.message}`);
  process.exit(1);
}

const { validateMenuPayload } = require(validatorPath);
const validation = validateMenuPayload(payload);

if (validation.errors.length > 0) {
  console.error(JSON.stringify(validation.errors, null, 2));
  process.exit(1);
}

process.stdout.write(String(validation.value.items.length));
'@

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $validationOutput = $validationProgram |
      & $nodeCommand.Source - $ResolvedMenuPath $validatorPath 2>&1
    $validationExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($validationExitCode -ne 0) {
    $details = ($validationOutput | Out-String).Trim()
    throw "The menu fixture is invalid.`n$details"
  }

  $dishCount = 0
  if (-not [int]::TryParse(
      ($validationOutput | Out-String).Trim(),
      [ref]$dishCount
    )) {
    throw "The menu validator did not return a dish count."
  }

  return $dishCount
}

function Get-TerraformOutput {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ResolvedTerraformDirectory,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $terraformCommand = Get-Command terraform -ErrorAction SilentlyContinue
  if (-not $terraformCommand) {
    throw "Terraform is required when -ApiBaseUrl is not supplied."
  }

  Push-Location $ResolvedTerraformDirectory
  try {
    $output = & $terraformCommand.Source output -raw $Name 2>&1
    if ($LASTEXITCODE -ne 0) {
      $details = ($output | Out-String).Trim()
      throw "Could not read Terraform output '$Name'.`n$details"
    }

    return ($output | Out-String).Trim()
  } finally {
    Pop-Location
  }
}

function Read-AdminIdToken {
  param(
    [Parameter(Mandatory = $true)]
    [string]$EnvironmentVariableName
  )

  $token = [Environment]::GetEnvironmentVariable(
    $EnvironmentVariableName,
    [EnvironmentVariableTarget]::Process
  )

  if (-not [string]::IsNullOrWhiteSpace($token)) {
    return $token.Trim()
  }

  $secureToken = Read-Host `
    "Paste the Cognito admin ID token (input is hidden)" `
    -AsSecureString
  $tokenPointer = [IntPtr]::Zero

  try {
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
      $secureToken
    )
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
  } finally {
    if ($tokenPointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    }

    if ($secureToken -is [IDisposable]) {
      $secureToken.Dispose()
    }
  }

  if ([string]::IsNullOrWhiteSpace($token)) {
    throw "A Cognito admin ID token is required."
  }

  return $token.Trim()
}

function Invoke-MenuApi {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("GET", "PUT")]
    [string]$Method,

    [Parameter(Mandatory = $true)]
    [string]$Uri,

    [Parameter(Mandatory = $true)]
    [string]$AdminIdToken,

    [string]$BodyPath
  )

  $request = @{
    Method  = $Method
    Uri     = $Uri
    Headers = @{ Authorization = $AdminIdToken }
  }

  if ($BodyPath) {
    $request["ContentType"] = "application/json"
    $request["InFile"] = $BodyPath
  }

  try {
    return Invoke-RestMethod @request
  } catch {
    $details = $_.ErrorDetails.Message
    if ([string]::IsNullOrWhiteSpace($details)) {
      $details = $_.Exception.Message
    }

    throw "$Method $Uri failed. $details"
  }
}

$resolvedMenuPath = Resolve-RequiredPath `
  -LiteralPath $MenuPath `
  -Description "The sample menu"
$expectedDishCount = Test-MenuPayload -ResolvedMenuPath $resolvedMenuPath

Write-Host "Validated $expectedDishCount dishes in '$resolvedMenuPath'."

if ($ValidateOnly) {
  return
}

$deploymentStage = ""
if ([string]::IsNullOrWhiteSpace($ApiBaseUrl)) {
  $resolvedTerraformDirectory = Resolve-RequiredPath `
    -LiteralPath $TerraformDirectory `
    -Description "The Terraform directory"
  $ApiBaseUrl = Get-TerraformOutput `
    -ResolvedTerraformDirectory $resolvedTerraformDirectory `
    -Name "api_base_url"
  $deploymentStage = Get-TerraformOutput `
    -ResolvedTerraformDirectory $resolvedTerraformDirectory `
    -Name "deployment_stage"
}

$ApiBaseUrl = $ApiBaseUrl.Trim().TrimEnd("/")
$parsedApiBaseUrl = $null
if (
  -not [Uri]::TryCreate(
    $ApiBaseUrl,
    [UriKind]::Absolute,
    [ref]$parsedApiBaseUrl
  ) -or
  $parsedApiBaseUrl.Scheme -ne [Uri]::UriSchemeHttps
) {
  throw "-ApiBaseUrl must be an absolute HTTPS URL."
}

$urlStage = $parsedApiBaseUrl.AbsolutePath.Trim("/")
$targetsProduction =
  $deploymentStage -eq "prod" -or
  $urlStage.Split("/")[-1] -eq "prod"

if ($targetsProduction -and -not $AllowProduction) {
  throw "Refusing to seed a production API. Use -AllowProduction only if replacing production data is intentional."
}

if ($deploymentStage) {
  Write-Host "Terraform deployment stage: $deploymentStage"
}
Write-Host "API base URL: $ApiBaseUrl"

$adminIdToken = Read-AdminIdToken `
  -EnvironmentVariableName $TokenEnvironmentVariable

try {
  $privateMenuUrl = "$ApiBaseUrl/dishes/private"
  $existingMenu = Invoke-MenuApi `
    -Method "GET" `
    -Uri $privateMenuUrl `
    -AdminIdToken $adminIdToken
  $existingDishCount = @($existingMenu).Count

  if ($existingDishCount -gt 0 -and -not $Force) {
    throw "The API already contains $existingDishCount dishes. No data was changed. Use -Force to replace the complete menu."
  }

  if ($existingDishCount -gt 0) {
    Write-Warning "Replacing the existing $existingDishCount-dish menu because -Force was supplied."
  }

  $uploadResponse = Invoke-MenuApi `
    -Method "PUT" `
    -Uri "$ApiBaseUrl/dishes" `
    -AdminIdToken $adminIdToken `
    -BodyPath $resolvedMenuPath

  $uploadedDishCount = @($uploadResponse.items).Count
  if ($uploadedDishCount -ne $expectedDishCount) {
    throw "The API response contained $uploadedDishCount dishes; expected $expectedDishCount."
  }

  $verifiedMenu = Invoke-MenuApi `
    -Method "GET" `
    -Uri $privateMenuUrl `
    -AdminIdToken $adminIdToken
  $verifiedDishCount = @($verifiedMenu).Count

  if ($verifiedDishCount -ne $expectedDishCount) {
    throw "Verification returned $verifiedDishCount dishes; expected $expectedDishCount."
  }

  $expectedIds = @(
    $uploadResponse.items |
      ForEach-Object { [string]$_.id } |
      Sort-Object
  )
  $actualIds = @(
    $verifiedMenu |
      ForEach-Object { [string]$_.id } |
      Sort-Object
  )
  $idDifferences = @(Compare-Object $expectedIds $actualIds)

  if ($idDifferences.Count -gt 0) {
    throw "Verification found different dish IDs than the uploaded fixture."
  }

  Write-Host "Seeded and verified $verifiedDishCount dishes successfully."
  Write-Host "RAG indexing continues asynchronously through DynamoDB Streams and SQS."

  [pscustomobject]@{
    ApiBaseUrl = $ApiBaseUrl
    DishCount  = $verifiedDishCount
    Version    = $uploadResponse.version
    UpdatedAt  = $uploadResponse.updatedAt
  }
} finally {
  $adminIdToken = $null
}
