// Show an error if the server sent us back with one
const error = new URLSearchParams(window.location.search).get("error");
const message = document.getElementById("message");

if (error === "wrong") {
  message.textContent = "Wrong password.";
} else if (error === "locked") {
  message.textContent = "Too many failed attempts. Try again in a few minutes.";
}
