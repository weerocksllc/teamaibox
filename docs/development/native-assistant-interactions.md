# Native Assistant interactions

The React Assistant uses the OpenCode session in the signed-in user's container.
Open a tool card to inspect its arguments, output and native status. **Tasks**
shows the session's task list. **Subsessions** opens work delegated by the
Agent; **Parent conversation** returns to the owning conversation.

## Permission and questions

- **Allow once** approves the displayed native request.
- **Always allow** uses OpenCode's native permission matching and lifetime. It
  is not a product-wide or cross-user authorization.
- **Reject** refuses the action. Depending on native execution state, the run
  can stop without another assistant answer.
- Choose an option or enter a custom answer in a question, then select **Send**.
  **Cancel** rejects the question; it does not manufacture an answer or restart
  the Agent.
- **Stop** requests native interruption of the selected running session. It
  does not delete the conversation, undo completed actions or clear history.

Pending permissions and questions are read from OpenCode after a connection
returns or a page refreshes. These actions use the original native request ID.
Opening a conversation does not resend its messages.

## Conversations and input

### Reading messages

Answers render Markdown while they arrive: headings, lists, links, quotes,
tables and code blocks. Code blocks identify the language and offer **Copy code**.
Mathematics appears inline or on its own line. Completed Mermaid blocks can show
a diagram; **Source** returns to the code. If an expression or diagram cannot be
rendered, its source remains available instead of hiding the answer.

Workspace images and supported image attachments have previews. Select an image
to enlarge it, then press Escape or **Close** to return. A missing or unsupported
image shows a preview-unavailable message. External images are not loaded
automatically: **Open external image** opens the indicated website in a separate
tab. Ordinary file attachments show their name and type, with **Download file**
when their bytes are available through the workspace or message.

**Thinking** expands the reasoning supplied by the native engine. Tool cards
show their actual pending, running, completed or failed state. Expand a card for
inputs, output and attachments; **Raw details** preserves its original fields.
Neither reading a tool card nor copying code executes it.

The conversation follows new output while you are at the bottom. Scroll back to
read earlier messages without being pulled forward; **Jump to latest** resumes
following. Wide tables and code scroll inside the message, leaving the input
available below.

### Projects and conversations

The project home shows your projects and recent conversations. Select a project
to return to its last conversation, or choose **New conversation** in the project
sidebar. **Find conversations** searches across your workspaces; the results can
also include archived conversations. Opening a result selects its project and
conversation together.

**Open a folder** browses your private workspace on the box. **New project**
creates a folder in the selected location; it does not initialize Git. To copy
files from your computer, choose **Import files** in the folder picker. Each
import accepts up to 100 ordinary files, up to 16 MiB each. Existing files are
kept and the result identifies files that were skipped or failed. Importing
files into a folder is separate from attaching them to a message.

**Project settings** opens native project and worktree settings. **Initialize
Git** creates a repository after confirmation without removing existing files.

In a Git project, **Git worktrees** creates a separate branch and working
directory. Creation can run the project's configured startup commands. Open the
new directory to work there; return to the main project before managing it.
**Reset worktree** discards its changes and untracked files, resets it to the
native default branch, and reruns startup commands. **Delete worktree** removes
the working directory and its branch permanently. Both require typing the
selected worktree's name. These actions do not delete the primary project.

Open **More actions** beside the conversation title for session management.
**Rename** changes the selected conversation's title. **Branch conversation**
creates an independent conversation with copied native history; it is not a
delegated subtask. **Delete conversation** asks for confirmation and deletes only
the selected native conversation, not its source branch or workspace files.
**Archive conversation** keeps its history out of the active list. Find it with
**Include archived**, then choose **Restore conversation** to bring it back.

Each conversation and each project's new-conversation view has its own draft.
Text, Agent/model choices and commands are saved in your browser for your box
account. Selected attachments remain available while switching conversations;
after refreshing, reselect any attachment marked as missing before sending.
If browser storage is unavailable or another tab changed the saved draft, a
notice explains what was not saved. Copy your current text before refreshing.
Failed submissions remain available to review and restore; restoration does
not replace a newer draft and never sends the message for you.

Use **Files** beside the title to browse files and changes. **Terminal** opens
the terminal below the conversation. Closing either view keeps your draft and
does not end a terminal process; use **End terminal** when you want to stop it.
On a smaller screen, the folder button in the header opens project navigation.
Press Escape to close an open navigation dialog or workspace panel.

**Edit message** lets you select a message part and change its text, delete the
part, or delete the whole message. Deletion asks for confirmation. These actions
change conversation history; they do not resend prompts or undo file changes
and tool actions. Deletion cannot be undone. Editing is disabled while the
conversation is running. If a record changes before saving, reopen it before
editing again; the rejected draft remains available to copy. The native API
does not provide an atomic lock across browser tabs, so avoid editing the same
message concurrently.

Public conversation sharing is unavailable in the selected OpenCode release.
Use **Import / export** to transfer a private copy instead, after reviewing its
contents.

**Import / export** downloads the selected conversation as native OpenCode JSON,
including messages, tool results and file references. Treat the downloaded file
as private; exports are not automatically redacted. Import uses a JSON file
already present in the selected container workspace. Enter its relative path,
confirm, and open the conversation when native import finishes. Existing
conversation IDs found before import are rejected rather than overwritten.
Do not import the same conversation concurrently from different tabs: the native
CLI has no atomic create-only option and can reassign an existing ID's workspace.
Importing history does
not replay its prompts or restore separately stored workspace files. Uploading
a JSON file directly from the browser is not yet provided by this dialog.

Choose an Agent and model before sending, or leave the configured defaults.
Attach files using the paperclip. **Enter** sends; **Shift+Enter** inserts a
newline, and confirming text in an input method does not send it. You can send
more input into the same running conversation. OpenCode controls when it is
processed; this is not a separately managed or individually cancellable queue.
**Queued** identifies input appearing after the current unfinished native
response. It is read from conversation history, not a countdown or a promise
about the order of future tool actions. **Stop** interrupts the session; it does
not claim to delete or cancel only one queued message.

**Find conversations** searches native titles across your workspaces. Use
**Current workspace** to narrow the results, **Include archived** to find earlier
archived records, and **Load more** for the next native page. Opening a result
returns to that original workspace and conversation, without replaying it.

The Assistant follows the language and theme selected in the product. New users
start in English. Drafts and selected attachments are cleared when signing out;
the next account opens its own container's conversations. On small screens the
history, message list and action bar scroll separately while the input stays
visible.

## Interrupted delivery

If the browser loses the response to a send, the request may already have been
accepted. Read the conversation before sending again. **Restore draft** restores
the text, files and selected input options for manual review; it does not send
them. Refreshing reconnects to the same session. Unsaved drafts remain only in
the current React view when browser storage is unavailable. Saved text and input
choices survive reload for the same account; attachment files must be reselected.

## Files and terminals

**Files / Terminal → Files → Git changes** shows the current branch and native
working-tree changes, including untracked files. Choose **Compare with default
branch** to see OpenCode's comparison with the project's default branch. Expand
a file to read its patch; **Refresh** reads changes made by a terminal or editor.
This view does not stage, commit, reset or delete files. A project without Git,
or without a default branch, displays the corresponding prerequisite instead
of implying that a comparison passed.
**Download patch** saves OpenCode's complete working-tree patch as
`workspace.patch`, including the untracked changes that native Git reports.
It does not change your files. Review patches before sharing them; their contents
are not automatically redacted.

**Changes** shows the native file diff for a chosen user message. Select the
turn in the dialog to inspect a different change; the selected upstream API
does not return a combined diff when the message ID is omitted.

**Files / Terminal** operates inside the selected workspace in your container,
not on the appliance host. File edits use native patch application and reject
conflicting changes. Review changes before saving. Git must be available and
the selected directory must meet the native operation's Git requirements.

Use **Find files** to search names or **Search file contents** to find matching
lines and open the result. The native content-search endpoint returns at most
ten matches per request.

**Revert to this message** uses OpenCode's snapshot/revert operation; **Undo
revert** restores its saved state. The view follows the native revert boundary,
even while the engine retains the reverted records for undo. Starting another
prompt can finalize the revert according to OpenCode's normal behavior. Revert
does not undo external effects such as an email or remote API call.

A disconnected terminal can reconnect to its existing native PTY. Closing the
panel is not the same as **End terminal**, which stops that PTY. Terminal access
does not provide host Docker access or another user's files.
Choose **Shell** before creating a terminal to use one of the executables
reported as available by OpenCode. **Default shell** keeps its native default.
Changing the selector does not replace or restart an existing terminal.

For a remote MCP connection, **Disconnect account** removes its saved native
authorization and disconnects the current connection. It does not remove the
server configuration or disable it permanently; use its enabled checkbox for
that. Other users' accounts and connections are unaffected.

**Shell command** runs a command directly in the selected conversation's
workspace and retains its output in native conversation history, without asking
a model to generate or execute the command. Review the command before selecting
**Run command**. Closing the dialog does not stop the process; use the
conversation's **Stop** control to interrupt it. If delivery cannot be confirmed,
inspect the conversation before submitting again; the UI does not retry it.
If multiple custom agents exist and the native default cannot be determined,
select an Agent in the conversation before running a shell command.

## Current compatibility boundary

**Assistant settings → Engine status** shows the native engine, language-server
and formatter status. **Workspace settings → Effective settings** is read-only.
**Runtime paths** lists the engine's actual home, state, configuration and
workspace paths inside your container, not on the appliance host.
**Edit configuration file** opens the workspace's `opencode.json` or
`opencode.jsonc`; when neither exists it prepares a new `opencode.json`.
Initialize Git in **Projects** first if the workspace is not a Git repository.
The editor validates syntax and the pinned native configuration schema, then
shows a full-context patch for review. Native patch application rejects
conflicting edits; there is no force-overwrite fallback. Existing JSONC comments
and formatting are preserved. This editor changes the source file, never a copy
of the merged platform-managed settings.

**Save** writes the file. **Reload workspace settings** separately reloads the
native instance and checks its effective configuration; saving alone is not
reported as applying settings. Finish active sessions and close terminals before
reloading. Schema validation does not establish that an external plugin, file
reference, service or credential is available. If a configuration edited outside
this form prevents a workspace from loading, open another valid workspace and
use its native terminal to repair that file. No container reset is needed to
edit a file. The pinned engine's broken project `PATCH /config` is not used.

The **Assistant settings · JSON** section edits native user-wide settings.
Invalid JSON remains in the editor for correction; valid changes are submitted
to OpenCode's own schema validation. Saving refreshes the model, Agent and command
selectors. Platform-managed configuration still takes precedence; changing user
settings does not grant host access or remove model/network restrictions.

**Tools and resources** shows native default-Agent tool descriptions and
parameter schemas for the selected model, discovered MCP resource metadata, and
native experimental capability flags. Resource URIs are displayed as text;
opening the catalog does not fetch their contents in the browser. Empty or
disabled capabilities are not represented as available integrations.

The selected 1.19.5 v1 conversation APIs and experimental v2 event-store APIs
are distinct. The Assistant supports the formal TUI/v1 conversation path;
the independent experimental v2 conversation mode is not supported. Its
queue/steer semantics are not emulated or mixed into this UI. See the
[capability map](native-assistant-capabilities.md) for the supported boundary
and native limitations. Updating a source checkout does not upgrade an installed
appliance; deploy matching Web, Platform API and Agent runtime artifacts together.
