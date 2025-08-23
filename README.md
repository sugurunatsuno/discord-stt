# Discord STT ボット

このリポジトリは、Discord のボイスチャットを録音し、Whisper (faster-whisper) で文字起こしした結果を指定したテキストチャンネルに投稿するボットです。

## 機能
- Slash コマンド `/join` `/leave` `/start` `/stop` でボットを操作し、参加・退出・録音開始/停止を行います。
- 録音した音声は Python スクリプト `stt.py` により faster-whisper で文字起こしされます。
- 文字起こし結果は指定したテキストチャンネルへ自動投稿されます。
- `.env` の環境変数でモデルやデバイス、ログレベルなどを設定できます。

## セットアップ
1. `.env.template` を `.env` にコピーして必要な値を設定します。
2. Python 仮想環境 `.venv` を作成して有効化し、`pip install -r requirements.txt` で依存パッケージをインストールします。
3. 初回は `./run.sh --install` で Node.js と Python の依存関係をインストールします。
4. ボットを起動するには `./run.sh` を実行します。

## 使い方
- Discord にボットを招待し、ボイスチャンネルで `/join` を実行すると参加します。
- `/start` で録音開始、`/stop` で録音停止、`/leave` でボイスチャンネルから退出します。
- 文字起こし結果は `DISCORD_TEXT_CHANNEL_ID` で指定したテキストチャンネルに投稿されます。

## ライセンス
ISC ライセンス
