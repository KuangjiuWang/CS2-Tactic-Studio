/** Some engine signatures are optional; HLAE can still load and play the demo. */
export function hasHlaeHookWarning(text: string): boolean {
 return /Could not find address for pattern|Problem in .*AfxHookSource2|Error - AfxHookSource2/i.test(text);
}
