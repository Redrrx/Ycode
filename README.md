# Ycode

Multi-model coding for Pi. Instead of one model reading files, editing code, running tests, and carrying every tool result into the next turn, Ycode splits the work:

| Role       | Job                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Main       | The model you picked in Pi. Has no tools. Defines the task and its permissions, then accepts the result, requests a revision, or stops.     |
| Worker     | Gets a fresh context for one task. Reads and edits files, runs authorized commands, and returns the useful answer with `finish_task`.       |
| Decision   | Optional. Helps a Worker tool rank candidate files or references. Known-path reads and exact text searches skip it. It does not plan tasks. |
| Summarizer | Runs when Pi compacts the conversation or you request a branch summary. It does not run after every task.                                   |

## One task

```text
You: Fix CSV quoting and run the CSV tests.
  |
  v
Main assigns one edit task: fix quoting, run the named test.
  |
  v
Worker finds the writer, reads it, edits it, runs the test.
  |    If a search needs ranking, the tool asks Decision.
  v
finish_task returns the answer. Ycode records the test exit code.
  |
  v
Main gives an explicit verdict for that task and revision.
  | accept: done, or the scheduler picks the next authorized task
  | revise: save feedback; a plan run pauses until you resume it
  | stop: no next task
```

## Where tokens go

Main gets the Worker’s result and compact project state, not the full tool transcript. Worker gets its task, relevant prerequisites, and checks, not the whole backlog. Within a Worker request, an identical source excerpt can be replaced by a reference if the full copy is still in context. A later task may need to read that file again.

This avoids repeating source and tool output. It does not guarantee a cheaper run: Main review costs a call, and Decision and Summarizer calls count too. Use `/usage` to see the breakdown by role.

## Install and use

From the Ycode checkout:

```sh
npm run setup
```

Keep the checkout in place. Main uses your selected Pi model. The other roles start empty. In `config.json`, set `worker.model` and `summarizer.model` to the OpenRouter chat model IDs you choose. Set `decision.model` to a supported OpenRouter classifier ID, or leave it blank to skip Decision. You can also keep these choices in `~/.pi/agent/perspi/config.json` instead of editing the checkout.

Start `pi` in your repo, or `/reload` after changing models. Run `/worker` and `/summarizer` to see supported effort levels. Set each with `/worker effort <level>` and `/summarizer effort <level>`, or set `effort` next to `model` in the config. Neither role runs without an explicit model and effort. Use `/login worker`, `/login summarizer`, and optionally `/login decision` for credentials.

Ask for a task directly, as in the diagram. For larger changes, ask Main to **save a plan**. Saving runs nothing. Tell it which tasks to run and which edits and commands you authorize. Use `/activity` to see progress. After a restart, open the same repo and ask to resume.
