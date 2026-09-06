$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Obj = Join-Path $RepoRoot "data\source\obj\lujiazui-camera-max\10-上海浦东陆家嘴群楼镜头\A.obj"
$Out = Join-Path $RepoRoot "frontend\public\runtime\lujiazui-camera-max\lujiazui.glb"
$Stage = Join-Path $RepoRoot ".cache\lujiazui-texture-stage"
Set-Location -LiteralPath $RepoRoot

Write-Host "[Lujiazui] source: $Obj"
Write-Host "[Lujiazui] output: $Out"
python (Join-Path $PSScriptRoot "prepare_lujiazui_textured_glb_noblender.py") --obj $Obj --out $Out --stage $Stage
if ($LASTEXITCODE -ne 0) { throw "Texture conversion failed with exit code $LASTEXITCODE" }
python (Join-Path $PSScriptRoot "verify_lujiazui_glb.py") "frontend/public/runtime/lujiazui-camera-max/lujiazui.glb"
if ($LASTEXITCODE -ne 0) { throw "GLB verification failed with exit code $LASTEXITCODE" }
