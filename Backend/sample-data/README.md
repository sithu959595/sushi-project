# RAG test menu

`rag-test-menu.json` is fictional test data that matches the request body
accepted by `PUT /dishes`. It contains 17 dishes with structured allergens, a
required `availability` value, and private `fullDishInfo` covering ingredients,
preparation, raw or cooked status, spice, dietary suitability, substitutions,
schedules, and cross-contact.

`availability` is a current menu snapshot with exactly two values:

- `available`: the dish can currently be ordered.
- `out`: the dish is currently unavailable.

The fixture intentionally marks `hamachi-citrus`, `hotate-yuzu`, and
`miso-black-cod` as `out`. General schedules and limits in `fullDishInfo` provide
context but do not override this current status. A recommendation for something
the guest can order now must exclude `out` dishes.

The data is for development and RAG evaluation only. It has not been reviewed
by a chef or food-safety professional and must not be used as production allergy
guidance. Images are intentionally omitted so the fixture does not reference
objects that do not exist in S3.

## SNOWFOX representative staging sample

`snowfox-menu-rag-sample.json` is a separate, synthetic RAG fixture based on
the 15 representative products shown on the public
[SNOWFOX menu](https://www.snowfox.com/menu/) on August 31, 2026. It is not a
confirmed inventory for the Corvallis kiosk; SNOWFOX says local selections can
vary and directs customers to the package label for complete details.

Each item has 239 to 255 words of generated `fullDishInfo`, arranged as two
meaningful paragraphs that fit the current chunk-size limit. Product names,
displayed calories, and short ingredient lines come from the public menu. The
remaining text is synthetic retrieval guidance, not an approved recipe,
nutrition statement, or food-safety specification.

To prevent accidental ordering, every sample price is `"0"` and every item is
`"out"`. Per-item `allergens` are intentionally omitted because SNOWFOX's
[allergen notice](https://www.snowfox.com/allergen-nutrition/) provides a
general handling warning rather than a reliable item-by-item matrix. Before any
customer-facing import, the local operator must replace prices and availability
and supply verified package-label ingredients and allergens. Do not use this
fixture to answer medical-diet or allergy-suitability questions.

Validate this sample locally from the repository root:

```powershell
& ".\Backend\sample-data\seed-rag-test-menu.ps1" `
  -MenuPath ".\Backend\sample-data\snowfox-menu-rag-sample.json" `
  -ValidateOnly
```

Do not remove `-ValidateOnly` until all placeholder and unverified fields have
been replaced with current Corvallis data.

## Validate the fixture

The command below parses and size-checks the JSON, requires an explicit valid
availability value on every fixture dish, and checks the complete request with
the backend menu validator.

Run it from the repository root in PowerShell:

```powershell
node -e "const fs=require('node:fs');const p='Backend/sample-data/rag-test-menu.json';const raw=fs.readFileSync(p,'utf8');const data=JSON.parse(raw);const {validateMenuPayload}=require('./Backend/terraform/lambda/handler/validate-menu');const allowed=new Set(['available','out']);const errors=validateMenuPayload(data).errors;const bytes=Buffer.byteLength(raw,'utf8');if(bytes>64*1024)errors.unshift({field:'body',message:'must not exceed 64 KiB'});if(Array.isArray(data.items))data.items.forEach((dish,index)=>{if(!allowed.has(dish.availability))errors.push({field:'items['+index+'].availability',message:'must be explicitly available or out'})});if(errors.length){console.error(JSON.stringify(errors,null,2));process.exit(1)}console.log('Valid fixture: '+data.items.length+' dishes, '+bytes+' bytes');"
```

## Load it through the existing API

The following request replaces the complete menu in a disposable development
or staging environment. Use a current Cognito admin ID token:

```powershell
$apiBaseUrl = "https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/staging"
$adminIdToken = "YOUR_COGNITO_ID_TOKEN"

Invoke-RestMethod `
  -Method Put `
  -Uri "$apiBaseUrl/dishes" `
  -Headers @{ Authorization = $adminIdToken } `
  -ContentType "application/json" `
  -InFile "Backend/sample-data/rag-test-menu.json"
```

## Load it with the helper script

`seed-rag-test-menu.ps1` validates this fixture with the backend's existing menu
validator, reads `api_base_url` from the active Terraform workspace, checks the
current private menu, uploads the fixture, and verifies all dish IDs. It refuses
to overwrite a non-empty menu unless `-Force` is supplied and refuses a
production stage unless `-AllowProduction` is supplied.

From the repository root:

```powershell
& ".\Backend\sample-data\seed-rag-test-menu.ps1"
```

If Windows blocks local PowerShell scripts, run it in a one-off process without
changing the machine's execution policy:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File ".\Backend\sample-data\seed-rag-test-menu.ps1"
```

The script securely prompts for a fresh Cognito admin ID token. For automation,
CI can inject the token through the `SUSHI_ADMIN_ID_TOKEN` process environment
variable. If it is set manually, remove it afterward:

```powershell
$env:SUSHI_ADMIN_ID_TOKEN = "YOUR_COGNITO_ID_TOKEN"
& ".\Backend\sample-data\seed-rag-test-menu.ps1"
Remove-Item Env:SUSHI_ADMIN_ID_TOKEN
```

Validate the fixture without making a network request:

```powershell
& ".\Backend\sample-data\seed-rag-test-menu.ps1" -ValidateOnly
```

To use an API URL without reading Terraform state:

```powershell
& ".\Backend\sample-data\seed-rag-test-menu.ps1" `
  -ApiBaseUrl "https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/staging"
```

After a successful upload, DynamoDB Streams and SQS asynchronously deliver the
per-dish indexing work to `rag-indexer`.

## Suggested RAG document shape

Create one vector document per dish so an edited dish can replace only its own
vector. Use a stable document ID such as `dish:<dish.id>`, and embed text in a
consistent form:

```text
Dish: <name>
Category: <category>
Public description: <description>
Structured allergens: <allergens or none listed>
Current availability: <availability>
Private menu context: <fullDishInfo>
```

Keep `dishId`, `category`, structured allergens, and `availability` as vector
metadata for filtering. Update or delete the dish vector whenever availability
changes so retrieval cannot recommend stale, unavailable results. An empty
allergen array means no supported allergen is listed in the recipe; it must not
be interpreted as a guarantee that the dish is allergy-safe. Use
`rag-evaluation-questions.md` as a first retrieval and grounding test set.
