# 生成 OCR 基准合成夹具（#79）：仅合成/匿名化内容，可提交 Git。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gen-ocr-fixtures.ps1
# 输出到 src/main/services/fixtures/ocr/（已提交，无需每次重新生成）。
# 依赖：Windows（System.Drawing）与中文字体（Microsoft YaHei）。
# 注意：本文件须以 UTF-8 BOM 保存（PS 5.1 按 ANSI 读取无 BOM 文件会解析失败）。

$ErrorActionPreference = 'Stop'
$outDir = Join-Path $PSScriptRoot '..\src\main\services\fixtures\ocr'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Add-Type -AssemblyName System.Drawing

function New-TextBitmap {
  param(
    [int]$Width,
    [int]$Height,
    [string]$Text,
    [string]$OutName,
    [float]$FontSize = 18,
    [string]$FontName = 'Microsoft YaHei',
    [System.Drawing.Color]$NoiseColor = [System.Drawing.Color]::Empty
  )
  $bmp = New-Object System.Drawing.Bitmap $Width, $Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $font = New-Object System.Drawing.Font($FontName, $FontSize)
  $brush = [System.Drawing.Brushes]::Black
  $y = 20
  foreach ($line in ($Text -split "`n")) {
    $g.DrawString($line, $font, $brush, 20, $y)
    $y += [int]($FontSize * 1.8)
  }
  # 可选噪声（模拟扫描/低清）：随机散布浅灰点
  if ($NoiseColor -ne [System.Drawing.Color]::Empty) {
    $rand = New-Object System.Random 42
    $noise = New-Object System.Drawing.SolidBrush($NoiseColor)
    for ($i = 0; $i -lt $Width * $Height / 60; $i++) {
      $g.FillRectangle($noise, $rand.Next(0, $Width), $rand.Next(0, $Height), 1, 1)
    }
  }
  $g.Dispose()
  $bmp.Save((Join-Path $outDir $OutName), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("generated: {0}" -f $OutName)
}

# 1. 清晰中文文本页（基准正确性对照）
New-TextBitmap -Width 900 -Height 500 -OutName 'text-zh.png' -Text @'
张伟
电话：138-0000-1234
邮箱：zhangwei@example.com
北京理工大学 本科 计算机科学与技术 2022-09 ~ 2026-06
技能：Java、Spring Boot、TypeScript
项目：校园二手交易平台
'@

# 2. 低清/噪声扫描页（OCR 质量下限）
New-TextBitmap -Width 900 -Height 500 -OutName 'scan-low-quality.png' -FontSize 14 -NoiseColor ([System.Drawing.Color]::FromArgb(230, 230, 230)) -Text @'
王芳
教育经历：中山大学 硕士 软件工程
联系方式 137-1234-5678
实习：某互联网公司 后端开发实习生
'@

# 3. 双栏页（阅读顺序检验）
New-TextBitmap -Width 900 -Height 500 -OutName 'two-column.png' -FontSize 16 -Text @'
左栏：个人信息 教育背景
姓名：李娜 学历：本科
电话：136-5566-7788 专业：计算机科学
右栏：项目经历
校园二手交易平台（Spring Boot）
'@

# 4. 易错字符页（0/O、1/l/I、日期分隔符、GPA 小数点）
New-TextBitmap -Width 900 -Height 400 -OutName 'error-chars.png' -Text @'
易错字符样例
电话：1O8-0O00-1234（O 与 0）
日期：202O-09 ~ 2O26-06
GPA：3.7/4.0 排名前 1O%
邮箱：zhangwei@examp1e.com（1 与 l）
'@

# 5. 三页扫描简历（三页总耗时基准；内容为匿名化合成，非私人简历）
New-TextBitmap -Width 900 -Height 620 -OutName 'page1.png' -Text @'
简历
张伟
电话：138-0000-1234
邮箱：zhangwei@example.com
求职意向：后端开发工程师（校招）
'@
New-TextBitmap -Width 900 -Height 620 -OutName 'page2.png' -Text @'
教育背景
北京理工大学 本科 计算机科学与技术 2022-09 ~ 2026-06
GPA 3.7/4.0 排名前 15%
相关课程：数据结构、操作系统、计算机网络、数据库原理
'@
New-TextBitmap -Width 900 -Height 620 -OutName 'page3.png' -Text @'
项目与技能
校园二手交易平台（Spring Boot + Redis）
技能：Java、Python、TypeScript、Git、Docker、Linux
自我评价：学习能力强，乐于钻研
'@
