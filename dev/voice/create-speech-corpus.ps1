param([string]$OutputDirectory = (Join-Path $env:TEMP '3dcar-asr-corpus'))

Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$texts = @(
  '小满同学',
  '小满同学，打开左前车窗',
  '小满同学，关闭右前车窗',
  '小满同学，降下左后车窗',
  '小满同学，升起右后车窗',
  '小满同学，打开左前门',
  '小满同学，关闭右后门',
  '小满同学，打开前备箱和后备箱',
  '小满同学，关闭所有车窗，熄火',
  '小满同学，车里有点闷热',
  '不用',
  '今天天气不错',
  '小满同学，把左前车窗打开一点',
  '小满同学，车窗打开一半',
  '小满同学，把所有车窗完全打开',
  '可以',
  '小满同学，把窗户放到一半的位置',
  '左前车窗',
  '再低一点',
  '好了',
  '帮我降下全部车窗吧',
  '那你帮我升起吧'
)
$voices = @('Microsoft Huihui Desktop', 'Microsoft Kangkang', 'Microsoft Yaoyao')
$cases = @()
for ($index = 0; $index -lt $texts.Count; $index++) {
  $filename = 'case-{0:00}.wav' -f ($index + 1)
  $voice = $voices[$index % $voices.Count]
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $synth.SelectVoice($voice)
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToWaveFile((Join-Path $OutputDirectory $filename), $format)
    $prompt = New-Object System.Speech.Synthesis.PromptBuilder
    $prompt.AppendBreak([TimeSpan]::FromMilliseconds(350))
    $prompt.AppendText($texts[$index])
    $prompt.AppendBreak([TimeSpan]::FromMilliseconds(1400))
    $synth.Speak($prompt)
  } finally { $synth.Dispose() }
  $cases += @{ file = $filename; text = $texts[$index]; voice = $voice }
}
$cases | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'corpus.json') -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $OutputDirectory 'case-16.wav') -Destination (Join-Path $OutputDirectory 'confirm.wav') -Force
Write-Output $OutputDirectory
