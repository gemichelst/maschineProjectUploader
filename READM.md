Stack: Node.js + Express backend · Single-file HTML frontend · SSE streaming · No build step
server.js — 458 lines
EndpointPurposeGET /api/statusHealth check: rclone binary, source folder, gdrive remoteGET /api/config + POST /api/configPersistent config at ~/.maschine-uploader/config.jsonGET /api/presets7 file type presetsPOST /api/scanfind with time/extension/exclude filters → file list + statsPOST /api/uploadSSE streaming rclone copy per file, real-time eventsPOST /api/upload/cancelKill active rclone processGET /api/historyLast 100 upload sessionsGET /api/browseDirectory browser for folder pickerGET /api/remotesAvailable rclone remotes
public/index.html — 2,013 lines, zero dependencies

Sidebar: time window pills (2h→7d→All), 7 file type presets, source folder picker with GUI browser, remote selector (auto-populated from rclone), destination folder + date toggle
Files tab: real-time extension stats strip · search/filter · sort by date/size/name · checkbox selection (all/none/invert/by-type) · total size of selection
Upload panel: dry-run toggle · auto-open GDrive toggle · SSE progress bars (overall + per-file + speed)
History tab: all sessions with stats, duration, destination
Settings tab: transfers, bandwidth limit, conflict mode (overwrite/skip/checksum), exclude patterns, GDrive folder ID
Keyboard shortcuts: R scan · U upload · L log · Ctrl+S save

How to run
bashunzip MaschineProjectUploader.zip
cd MaschineProjectUploader
npm install
npm start
# → http://localhost:3847
