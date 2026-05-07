# submitMYSC

Public entry shell for the MYSC payment evidence submission surface.

The production domain stays intentionally narrow:

- `/` serves a lightweight public shell.
- `/payment-evidence/submit/:token` rewrites to the inner-platform submission UI.
- `/api/public/*` rewrites to the inner-platform BFF public API.
- `/assets/*` rewrites to inner-platform build assets for the proxied submission UI.

## Local Preview

Open `index.html` in a browser, or serve the directory with any static server.
