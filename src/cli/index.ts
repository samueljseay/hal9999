import { printHelp } from "./help.ts";
import { runCommand } from "./run.ts";
import { psCommand } from "./ps.ts";
import { logsCommand } from "./logs.ts";
import { eventsCommand } from "./events.ts";
import { showCommand } from "./show.ts";
import { poolCommand } from "./pool.ts";
import { vmCommand } from "./vm.ts";

function deprecation(oldCmd: string, newCmd: string): void {
  console.error(`\x1b[33mDeprecation:\x1b[0m "hal ${oldCmd}" is now "hal ${newCmd}"\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  // --- Backward compatibility: task <sub> → new command ---
  if (command === "task") {
    const sub = rest[0];
    const subRest = rest.slice(1);

    switch (sub) {
      case "create": {
        deprecation("task create --repo X --context Y", "run <repo> -m <msg>");
        // Translate --repo and --context into positional + -m
        const translated: string[] = [];
        for (let i = 0; i < subRest.length; i++) {
          if (subRest[i] === "--repo" && subRest[i + 1]) {
            translated.unshift(subRest[i + 1]!);
            i++;
          } else if (subRest[i] === "--context" && subRest[i + 1]) {
            translated.push("-m", subRest[i + 1]!);
            i++;
          } else {
            translated.push(subRest[i]!);
          }
        }
        return runCommand(translated);
      }
      case "list":
        deprecation("task list", "ps");
        return psCommand(subRest);
      case "watch":
        deprecation("task watch <id>", "logs <id>");
        return logsCommand(subRest);
      case "get":
        deprecation("task get <id>", "show <id>");
        return showCommand(subRest);
      case "events":
        deprecation("task events <id>", "events <id>");
        return eventsCommand(subRest);
      default:
        console.error(`Unknown task command: ${sub}`);
        console.log("Available: task create, task list, task watch, task get, task events");
        console.log("(These are deprecated — use: run, ps, logs, show, events)");
        process.exit(1);
    }
  }

  // --- Primary commands ---
  switch (command) {
    case "run":
      return runCommand(rest);
    case "ps":
      return psCommand(rest);
    case "logs":
      return logsCommand(rest);
    case "events":
      return eventsCommand(rest);
    case "show":
      return showCommand(rest);
    case "pool":
      return poolCommand(rest);
    case "vm":
      return vmCommand(rest);
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
