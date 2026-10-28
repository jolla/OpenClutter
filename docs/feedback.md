# Feedback form

The "Feedback" link by the version opens a short form: type (Bug, Suggestion, Other), message, up to 3 screenshots (paste, drop, choose a file, or Attach map view), an optional email, and Send.

Reports are **private**. Each one becomes an issue in a private repo, and its screenshots are stored as files in that private repo, so only people with access to it can see the report, the screenshots or the email. Nothing goes to the public OpenClutter repo.

## Setup (Netlify environment variables, Functions scope)

| Variable | Value |
| --- | --- |
| `FEEDBACK_PRIVATE_REPO` | `jolla/OpenClutter-feedback` |
| `GITHUB_FEEDBACK_PRIVATE_TOKEN` | fine-grained token, only `jolla/OpenClutter-feedback`: Issues read and write, Contents read and write (Metadata read is included) |

If either is missing, the form says feedback is not set up yet and the function answers 503 `not_configured`.

The private repo needs at least one commit (a README is enough) so screenshot files have a branch to go on. Labels (`bug`, `enhancement`, `feedback`, `user-feedback`) are created by GitHub on first use; if GitHub refuses them, the issue is filed without labels.

## Privacy and abuse

- An email the reporter leaves is shown as "Reply to" in the private issue and nowhere else.
- Screenshots are re-drawn on a canvas by the page and saved as WebP (or JPEG), at most 1600 px and about 500 KB each, which drops photo metadata such as GPS. The function accepts only JPEG or WebP bytes, at most 600 KB each and 3 per report, and commits them to `screenshots/YYYY-MM/` in the private repo under random names.
- The message is put inside a code block on the issue, so mentions, links, images and HTML do not render. Titles have mentions and issue references broken up. More than 3 links is refused.
- A hidden honeypot field and a minimum fill time drop bots without an issue. Limits per IP hash: 3 per 10 minutes and 10 per day, plus 60 reports per day site-wide (Netlify Blobs).
- Only requests from openclutter.com, dev.openclutter.com and openclutter Netlify deploys are accepted. Bodies over 3 MB are refused.
- Nothing from a report (message, email, IP) is written to the function logs.
