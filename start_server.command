#!/bin/bash
# Double-click to start the DM Screen server.
# Type "stop" or "exit" and press Enter to shut it down, or "restart" to restart it.

# Run from the folder this file is in
cd "$(dirname "$0")" || exit 1

# Finder does not load your shell settings, so add the usual Node locations
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# Show a message and wait, so the window does not vanish before it is read
fail() {
  echo ""
  echo "$1"
  read -r -p "Press Enter to close this window."
  exit 1
}

# Check that Node, the password file, and the port are ready
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js was not found. Install it from https://nodejs.org and try again."
fi
if [ ! -f .env ]; then
  fail "No .env file. Create one in this folder with the line: DM_PASSWORD=yourpassword"
fi
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port 3000 is already in use. The server may already be running in another window."
fi

# Start the server in the background so this window can listen for commands
start_server() {
  node --env-file=.env app.js &
  SERVER_PID=$!
}
start_server

# Stop the server and wait until it has fully exited
stop_server() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Stopping the server..."
    kill "$SERVER_PID"
    wait "$SERVER_PID" 2>/dev/null
  fi
  echo "Server stopped."
}

# Stop the server and start it again in this same window
restart_server() {
  echo "Restarting the server..."
  stop_server
  start_server
  sleep 1
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "The server did not restart. See the error above."
  fi
  echo "Server restarted. Log in to the DM page again."
}

# Close this Terminal window (skipped if it has other tabs, or if not run in Terminal)
close_this_window() {
  if ! tty -s; then
    exit 0
  fi
  local my_tty window_id
  my_tty=$(tty)
  # Find this window's id while the script is still running in it
  window_id=$(osascript - "$my_tty" 2>/dev/null <<'APPLESCRIPT'
on run argv
  tell application "Terminal"
    repeat with w in windows
      try
        if (count of tabs of w) is 1 and (tty of tab 1 of w) is (item 1 of argv) then return id of w
      end try
    end repeat
  end tell
  return ""
end run
APPLESCRIPT
)
  if [ -n "$window_id" ]; then
    # Close it a moment after this script exits; nohup keeps the closer running past the shell
    nohup osascript -e "delay 1" -e "tell application \"Terminal\" to close window id $window_id" >/dev/null 2>&1 &
  fi
  exit 0
}

# Also stop it if the window is closed or Ctrl+C is pressed
trap 'echo ""; stop_server; exit 0' INT TERM HUP

# Give the server a moment, then make sure it is still running
sleep 1
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  fail "The server did not start. See the error above."
fi

# Show the addresses to open
echo ""
echo "Player display: http://localhost:3000/"
echo "DM page:        http://localhost:3000/dm.html"
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null)
if [ -n "$LAN_IP" ]; then
  echo "Other devices on this Wi-Fi: http://$LAN_IP:3000/ and http://$LAN_IP:3000/dm.html"
fi
echo ""
echo 'Type "restart" and press Enter to restart the server, or "stop" or "exit" to shut it down.'

# Wait for "restart", "stop" or "exit" (any capitals)
while read -r input; do
  command_word=$(echo "$input" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  if [ "$command_word" = "stop" ] || [ "$command_word" = "exit" ]; then
    break
  fi
  if [ "$command_word" = "restart" ]; then
    restart_server
    continue
  fi
  # The server may have crashed while we waited
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "The server has stopped on its own. See the error above."
  fi
  if [ -n "$command_word" ]; then
    echo 'Type "restart" to restart the server, or "stop" or "exit" to shut it down.'
  fi
done

stop_server

# Wait for one key press, then close the window
echo ""
echo -n "Press any key to continue..."
read -r -n 1 -s
echo ""
close_this_window
