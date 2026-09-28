/* Glob → RegExp for the watch/protected policy in lib/policy.js. Pure, so the
 * tests under test/ cover it directly.
 *
 *   `**` spans any number of directories, `*` any run within one directory,
 *   `?` a single character. Everything else is literal. */

export function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:[^/]*/)*"; /* any number of leading directories */
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".indexOf(c) >= 0) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/* The globs as labelled matchers, so a panel can show one row per pattern. */
export function compileMatchers(globs) {
  return globs.map((pattern) => {
    const re = globToRe(pattern);
    return { pattern, test: (p) => re.test(p) };
  });
}

/* A pattern trimmed for display: drop the leading `**​/`, collapse inner `**`. */
export const shortGlob = (p) => p.replace(/^\*\*\//, "").replace(/\*\*/g, "…");
