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

## When Decision helps

If a search for the CSV writer turns up several files or references, Decision can rank which ones the Worker should inspect first. The Worker still reads the code. Reading a known path or searching for exact text does not call Decision.

The decision model's choices are best-effort; misleading code can make them wrong.

## Where tokens go

Main gets the Worker’s result and compact project state, not the full tool transcript. Worker gets its task, relevant prerequisites, and checks, not the whole backlog. Within a Worker request, an identical source excerpt can be replaced by a reference if the full copy is still in context. A later task may need to read that file again.

This avoids repeating source and tool output. It does not guarantee a cheaper run: Main review costs a call, and Decision and Summarizer calls count too. Use `/usage` to see the breakdown by role.

## Install and use

```sh
pi install git:github.com/Redrrx/Ycode
```

1. Start `pi` in your repo (or `/reload`). Run `/login worker` and `/login summarizer` to pick each model and enter its OpenRouter key. `/login decision` is optional.
2. Set effort per project, for example `/effort high worker` and `/effort low summarizer`. `/worker` and `/summarizer` list supported levels.
3. Ask for a task, or ask for a plan and say when to run it. Check progress with `/activity`.
