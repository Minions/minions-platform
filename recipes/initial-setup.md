## Pre-reqs

- [Node.js](https://nodejs.org/en/download). Any version after 18 should do, but latest is the only thing we test.
- Claude Code: `irm https://claude.ai/install.ps1 | iex` (powershell) or `curl -fsSL https://claude.ai/install.sh | bash` (bash).
- Run claude code and get through initial config, including getting an account.
- Make sure you can get to the git repos that you will be analyzing. If they are on GitHub, it can be handy to install the gh CLI and log in. For BitBucket, there's no CLI, but you can generate and use an API key.

## Set up the tools

1. Unzip the archive we gave you. Rename new_lair to whatever you want - something that describes your purpose for this install.
2. Open two separate terminal windows to that folder.
3. In the first terminal, run `node ./tools/runtime/main.js` to start the cabinet runtime. This will print a URL to the terminal window, which we call the cabinet URL.
4. In the second terminal, run `claude mcp add --scope project --transport http cabinet <cabinet-URL>/mcp`.
5. In that same terminal, run `claude --dangerously-skip-permissions`.
   - Note: you can also run without this flag, but it will prompt you for each permission. This is far safer, but also **far** slower and forces you to pay attention to everything Claude does.
6. Paste the following into Claude Code. Keep claude running when it finishes.
    ```
   Add the following work archives.
    
   * minions: https://github.com/CodeWarp/suite.git
    
   Then create the following wings.
    
   * name: minions, work repo: minions, description: Run the runtimes from here, so we can choose when to update versions
   * name: planning, work repo: minions, description: Do all the planning activities
   * name: workshop-00, work repo: minions, description: One of the equivalent wings for building stuff
   * name: workshop-01, work repo: minions, description: One of the equivalent wings for building stuff
   * name: workshop-02, work repo: minions, description: One of the equivalent wings for building stuff
   
   Then debug install the following costumes.
   
   * name: dev-and-check, wing: minions, path: costumes/dev-and-check
   * name: eliminate-duplication, wing: minions, path: costumes/eliminate-duplication
   * name: harden-api, wing: minions, path: costumes/harden-api

    Finally, in `wings/minions/work/local/apps/cabinet`, run `pnpm install && pnpm run build`
    ```

7. Go back to the browser and refresh. You should now see 1 work archives (minions). Also click on wings and you should see 5 wings. Fix any issues either manually in the throne room or by asking claude to do it.
8. When everything is right, go to the claude code terminal and type `/exit` and close the terminal window.
9. In the terminal running cabinet, type `q` to exit the cabinet server. Run the cabinet that Claude just built from source with `node ./wings/minions/work/local/apps/cabinet/dist/main.js`.

You are now done with setup.

## To make plans

1. Open a terminal window and navigate to the `<lair-root>/wings/planning` directory. Type `claude --dangerously-skip-permissions` to start claude code.
2. Run `dev-and-check:create-prd` and respond to Claude's questions.

## To build things

1. Open a terminal window and navigate to one of the free workshops (`<lair-root>/wings/workshop-XX`). Type `claude --dangerously-skip-permissions` to start claude code.
2. Run `dev-and-check:orchestrate`. It will work autonomously to build your feature, and ask you when it wants to demo.
