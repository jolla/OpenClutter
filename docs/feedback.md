# Feedback form

The "Feedback" link by the version opens a short form: type (Bug, Suggestion, Other), message, up to 3 screenshots (paste, drop, choose a file, or Attach map view), an optional email, and Send.

Reports are **private by default**. They become issues in a private repo, and their screenshots are stored as files in that private repo, so only people with access to it can see them. A report is public only when the reporter ticks **Post publicly on GitHub**; then it becomes an issue in the public repo, with screenshots served from Netlify Blobs.

## Setup (Netlify environment variables)

| Variable | Needed for | Value |
| --- | --- | --- |
| `FEEDBACK_PRIVATE_REPO` | private reports | `owner/repo` of a private repo, for example `jolla/OpenClutter-feedback` |
| `GITHUB_FEEDBACK_PRIVATE_TOKEN` | private reports | fine-grained token, only that private repo: Issues read and write, Contents read and write |
| `GITHUB_FEEDBACK_TOKEN` | public reports (optional) | fine-grained token, only `jolla/OpenClutter`: Issues read and write |
| `GITHUB_FEEDBACK_REPO` | optional | public repo, default `jolla/OpenClutter` |
| `FEEDBACK_PUBLIC_EMAIL` | optional | address for the "or email" link in the form |

Fine-grained tokens always include Metadata read. Use two tokens so the token that can write files never touches the public repo. Set the variables for the Functions scope.

- Neither repo set up: the form says feedback is not set up yet, and the function answers 503 `not_configured`.
- Only the private repo: the public option is hidden.
- Only the public repo: the box is always shown, and nothing is sent until the reporter ticks it.

The private repo needs at least one commit (a README is enough) so screenshot files have a branch to go on. Labels (`bug`, `enhancement`, `feedback`, `user-feedback`, `contact`) are created by GitHub on first use.

## Privacy and abuse

- The email is never put on a public issue. On a private report it is in the private issue. On a public report it goes in a separate private issue that links to the public one, or is dropped when there is no private repo (the form hides the email box then).
- Screenshots are re-drawn on a canvas by the page and saved as WebP (or JPEG), at most 1600 px and about 500 KB each, which drops photo metadata such as GPS. The function accepts only JPEG or WebP bytes, at most 600 KB each and 3 per report.
- Public screenshot links use 128-bit random ids. The image function checks the bytes again and sends `nosniff` and a sandboxed content policy.
- The message is put inside a code block on the issue, so mentions, links, images and HTML do not render. Titles have mentions and issue references broken up. More than 3 links is refused.
- A hidden honeypot field and a minimum fill time drop bots without an issue. Limits per IP hash: 3 per 10 minutes and 10 per day, plus 60 reports per day site-wide (Netlify Blobs).
- Only requests from openclutter.com, dev.openclutter.com and openclutter Netlify deploys are accepted.
- Nothing from a report (message, email, IP) is written to the function logs.
