/* ---------- DOM ---------- */
/* Moved verbatim out of app.js. This is the one-character helper the whole app is
   written against, in its own module so toast.js can import it without dragging in
   anything else. Keep this file free of dependencies — everything else imports it. */

const $=id=>document.getElementById(id);

export { $ };
