## What's new - v.4.8.0

- **Steer fixed**: Removed raw mode management from editor (readline owns it), upgraded steer to use the editor module — now supports paste pills, Ctrl+U/W, and proper rendering                                                                    
- **Late steer handling**: When a steer arrives during the agent's final text response, the response is discarded and re-requested with the steer injected (fixes 
silent steer drop)
- **Single-row rendering**: Prompt never wraps — uses horizontal viewport with `…`  
indicators when content exceeds terminal width, preventing terminal scroll from     
overwriting output above           
- **Paste fixes**: Normalized `\r`/`\r\n` to `\n` for correct line counting; added  
character-length threshold (>=200 chars) for pill detection; smart pill labels (`N  
lines` vs `N chars`)               
- **Status footer**: Editor-scoped footer showing model, context %, tokens, cost,   
and turn — visible only during `you>` and `steer>` prompts using ANSI scroll region 
- **Prompt simplified**: `[turn N] you>` → `you>` (turn number moved to footer)
- **Context bar removed**: Redundant with footer; `/context` still shows full       
breakdown                                                                           
- **Shift+Tab**: Cycles completion candidates backward                              
- **Ctrl+C**: Exits process at prompt, cancels steer during agent execution