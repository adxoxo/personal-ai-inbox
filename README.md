# Personal AI Inbox

Save a private Telegram message, image, or link now and review its notes later in Notion.
Every extracted note starts in **Inbox**, including tasks.
Category describes the note. Status tracks your later review or action.

The service runs locally. Notion holds editable notes.
The local journal preserves accepted captures and supports delivery recovery.
Private media and page-context caches form part of the data backup.

## Current status

The local implementation and synthetic provider checks pass.
The current local installation has Telegram, DeepSeek, and Notion accounts configured.
The configured bot is @EasySaveAdyu_Bot. Local text capture and delivery checks passed.
The current installation uses the local Overmind supervisor described below.
Image and link code checks pass. Real vision, Fetch, and Notion image readback checks also pass.
Adam's real-photo and link acceptance remains open.
No client credential is included or reused.
The 14-day trial has not started.

## Offline proof

Use Node.js 22 or newer. Run these commands from this directory:

~~~bash
npm ci
npm test
npm run demo
~~~

The demo uses synthetic providers and an isolated temporary data directory.
It makes no account connection.
It saves two notes, restarts the journal, and checks duplicate input.

## Connect your accounts

Copy the configuration template, then set private file permissions:

~~~bash
cp .env.example .env
chmod 600 .env
~~~

Use your own credentials. Enter secrets directly in the local file.
The application reads this file and explicit environment variables.
It has no credential lookup in other projects.

Set:

- Your Telegram bot token and numeric Telegram user ID.
- Your personal DeepSeek key and selected model.
- Your confirmed IANA timezone, such as Asia/Manila or Etc/UTC.
- A Notion internal integration token and parent page ID.
- A persistent private data directory, or keep the local data default.

### Notion setup

Create an internal integration named Personal AI Inbox in your chosen Notion workspace.
Enable read and insert content capabilities.
Create a dedicated parent page, then grant the integration access to that page.
Set NOTION_TOKEN and NOTION_PARENT_PAGE_ID in the local configuration.

The official [internal connection guide](https://developers.notion.com/guides/get-started/internal-connections) describes these permissions.

Once that account connection and database creation are authorized, run:

~~~bash
npm run setup:notion
~~~

The command creates one Personal Inbox database or reuses its existing destination.
It checks the parent, data source, fields, and category options.
It saves destination IDs privately in data/notion-setup.json.
You can leave the database and data source environment variables empty after this setup.
If you supply them, they must match the saved destination.

A copied Notion ID can have hyphens or omit them.
Use the ID itself, rather than the entire page URL.

Setup never changes an unrelated database.
If a create response is uncertain, it records that condition and prevents a blind second create.
Check the parent page, then provide the existing database ID before another setup attempt.

## Notion organization

Each extracted entry is a row and a page in one database.

| Field | Purpose |
|---|---|
| Name | Short note title. |
| Category | Task, Idea, Knowledge, Journal, or Reference. |
| Project | Optional project name from the message. |
| Tags | Topic labels. |
| Status | Inbox initially; you can later select Open, Done, or Archived. |
| Captured At | Original Telegram message time. |
| Due Date | An explicit, unambiguous task deadline, otherwise empty. |
| Source ID | Identity shared by entries from one message. |
| Item ID | Identity of one extracted entry. |

Each page contains extracted content and the complete original message.
Keep Source ID and Item ID intact so recovery can identify existing notes.

The current installation has native Notion views. For a fresh installation, configure these views after setup:

| View | Filter |
|---|---|
| Inbox | Status equals Inbox. |
| Tasks | Category equals Task. |
| Ideas | Category equals Idea. |
| Knowledge | Category equals Knowledge. |
| Journal | Category equals Journal. |
| References | Category equals Reference. |
| All Notes | No category filter. |

You can filter All Notes by Inbox status for later review.
The current views were provisioned during authorized setup. The message worker does not change their configuration.
## Images and links

Send a photo or screenshot, with or without a caption.
You can also send JPEG, PNG, GIF, or WebP files up to 5 MiB.
A photo uses the largest version Telegram supplies. An image file preserves the supplied file bytes.
Each image in an album becomes a separate source message.

DeepSeek analyzes the image and caption. Notion retains the original received image, caption, and extracted notes.
Images use private local files and Notion-managed uploads. Telegram download URLs never reach the model or Notion.

The bot reads up to three unique links from message text, captions, or Telegram text-link entities.
DeepSeek Fetch supplies a page title and a bounded excerpt for each available public page.
Notion retains each source URL, its retrieval state, and up to 12,000 characters of page context.
An unavailable page retains its URL. The model must not invent unseen page contents.
Temporary provider limits can leave delivery pending until the recorded cooldown ends.

The URL check rejects credentials, IP literals, and known local hostname suffixes.
DeepSeek Fetch controls DNS resolution and remote destination enforcement. The bot has no local scraper.
Links inside image pixels do not trigger a second page-fetch pass.
Fetched page text cannot override the extraction rules or create tasks from article instructions.

Media and context caches survive retries and restarts. Preserve them with the journal during backup.
The bot reuses a valid Notion upload until it expires. An unattached upload can expire without a page.
Page identity checks still prevent blind duplicate creation after an uncertain response.

## Run locally

After all required configuration and account permissions are ready:

~~~bash
npm run build
npm start
~~~

Startup verifies the Notion destination before Telegram intake begins.
Keep this foreground process and its host available.
Press Ctrl+C for a normal shutdown.
No public endpoint or cloud deployment is required. Optional host startup units appear below.

### Local crash recovery

The installed Overmind and tmux tools can supervise this bot within the current container.

~~~bash
npm run build
npm run supervise
npm run supervise:status
npm run supervise:stop
~~~

The supervisor retains the existing bot, journal, providers, and account configuration.
After a worker exit, it waits 15 seconds before a restart.
The worker wrapper recovers a lock only when the existing guard proves its owner dead on this host.
An active or unverifiable lock blocks startup. Captured data remains intact.
Use `supervise:stop` before an offline status command or backup.
Inspect private runtime output with `overmind echo`. Never copy captured content into shared reports.

This daemon survives an individual worker crash. Automatic container recovery requires the host timer below.
Use `npm run startup` for guarded startup or recovery. Do not run the foreground bot beside the supervisor.
Run `npm run test:supervisor` for isolated crash and journal-retention proof.

### Container startup on the Ubuntu host

The host timer checks Work2 every 30 seconds. It skips a stopped container.
When Work2 runs, it ensures the existing Overmind supervisor runs too.
The starter serializes concurrent requests and retains the existing journal and worker lock guard.
It preserves live sockets and moves only a verified refused socket aside.

From this repository on the Ubuntu host, install and activate the two user units:

~~~bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/work2-inbox-autostart.service deploy/systemd/work2-inbox-autostart.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now work2-inbox-autostart.timer
systemctl --user start work2-inbox-autostart.service
~~~

The units target the existing `job-work2` container and this app's `/home/node/projects/` checkout.
The user service manager must run. The timer does not start Work2 itself or enable host linger.
Host reboot recovery still depends on the existing container and user-session setup.

For an intentional stop, stop the host timer before the supervisor:

~~~bash
systemctl --user disable --now work2-inbox-autostart.timer
podman exec --user 1000:1000 --workdir /home/node/projects/personal-projects/personal-ai-inbox job-work2 npm run supervise:stop
~~~

Without that timer stop, the next timer check restores the supervisor.
To remove this integration, disable its timer, remove only its two unit files, and reload the user service manager.
Use `npm run test:startup` for isolated stale-socket, concurrent-start, live-socket, and data-retention checks.
Host timer activation and an actual container-restart-to-capture check require separate live evidence.

Send a private text message, photo, image file, or public link to the bot.
The first reply confirms durable local receipt.
A later reply confirms the Notion pages and includes links.

Bot commands:

- /status reports captured, confirmed, pending, and review counts.
- /retry requeues failed work without bypassing a provider cooldown.
- /help explains supported captures.

Only the configured user can submit notes.
Groups, edits, unsupported files, oversized images, and voice input do not enter the note queue.

## Recovery and backup

Transient failures use bounded retries.
Provider wait instructions survive restart.
An uncertain Notion write is checked by Item ID before another create.
If its outcome remains unknown, the message stays pending for review.
Completed pages are never overwritten during retry.

A failed confirmation can cause another Telegram reply.
It does not cause another Notion page.
A crash after a reply but before its journal record can produce a duplicate reply.

Use Telegram /status while the bot runs.
The local CLI requires the bot to be stopped:

~~~bash
npm run status
npm run retry
~~~

After a hard process kill, a lock can remain.
The following command removes it only if its recorded owner is dead on this host:

~~~bash
npm run recover-lock
~~~

Do not remove an active process lock.
Do not edit or truncate a damaged journal.
Preserve a private copy before a manual repair.

For a backup, stop the service and copy the entire data directory to private storage.
Keep the original copy and its file permissions.
Restore into a separate directory before replacing active data.
Include the media and context-cache directories. Their files preserve accepted images and page context.
A missing or altered image remains pending for review.
The earlier text-only runtime cannot read new media journal events.
Keep post-upgrade captures intact before any source rollback.
Remove a stale lock only through the verified recovery command.

If a restored backup lacks extraction but Notion already has notes for that source, recovery stops for review.
Use a newer complete backup or reconcile the source manually.
This prevents a new model result from remapping old item indices.

Telegram retains undelivered updates for at most 24 hours.
A local backup protects received messages, not messages the bot never received.
See [Telegram update delivery](https://core.telegram.org/bots/api#getupdates).

## Fourteen-day trial

Start the trial after a real note reaches Notion and you retrieve it later.
Capture at least 20 notes and revisit saved information at least three times.
Review category accuracy against the 80% target and check for silent loss of accepted messages.
Record downtime, delayed captures, known missed messages, and manual restart effort.
Then decide whether to keep this workflow and whether local availability meets your needs.

Cloud hosting is a later decision.
Transcription, AI search, and Grimoire integration remain outside this version.

