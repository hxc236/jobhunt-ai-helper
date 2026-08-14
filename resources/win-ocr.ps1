param([string]$ImagePath)
# Windows.Media.Ocr 中文 OCR：识别图片文字，逐行输出（UTF-8）。
# issue #67：截图提取岗位信息的 OCR 引擎（grill Q4 决策：Windows 系统 OCR）。
# 调用方（src/main/services/ocr.ts）会去掉本 param 行并把图片路径字面量
# 内联进 GetFileFromPathAsync 调用（PS 5.1 -EncodedCommand 限制，见该文件注释）。
$ErrorActionPreference = 'Stop'

# 注册 WinRT 类型
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

# WinRT async → .NET Task 等待
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

# 图片 → SoftwareBitmap
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

# 中文识别引擎（zh-Hans-CN；系统未装中文语言包则失败，调用方提示）
$lang = New-Object Windows.Globalization.Language('zh-Hans-CN')
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) { Write-Output 'ENGINE_FAIL'; exit 1 }

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
# UTF-8 输出（调用方按 UTF-8 解析）
[Console]::OutputEncoding = [Text.Encoding]::UTF8
foreach ($line in $result.Lines) { Write-Output $line.Text }
