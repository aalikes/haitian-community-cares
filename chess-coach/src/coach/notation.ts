/**
 * Speech-friendly chess notation.
 *
 * A screen reader or TTS voice given "Nxd4+" says something like "en ex dee
 * four plus", which is useless as coaching audio. These helpers turn notation
 * into the words a human coach would actually say.
 */

const PIECE_WORDS: Record<string, string> = {
  K: "king",
  Q: "queen",
  R: "rook",
  B: "bishop",
  N: "knight",
};

const FILE_WORDS: Record<string, string> = {
  a: "a",
  b: "b",
  c: "c",
  d: "d",
  e: "e",
  f: "f",
  g: "g",
  h: "h",
};

const SAN_PATTERN =
  /^([KQRBN])?([a-h]?[1-8]?)(x)?([a-h][1-8])(?:=([QRBN]))?([+#])?$/;

/** "Nxd4+" -> "knight takes d4, check". */
export function sanToSpeech(san: string): string {
  const clean = san.replace(/[!?]+$/, "").trim();
  if (clean === "O-O" || clean === "0-0") return "castles short";
  if (clean === "O-O-O" || clean === "0-0-0") return "castles long";

  const match = SAN_PATTERN.exec(clean);
  if (!match) return clean;

  const [, pieceLetter, disambiguation, capture, target, promotion, suffix] = match;
  const parts: string[] = [];

  if (pieceLetter) {
    parts.push(PIECE_WORDS[pieceLetter] ?? pieceLetter);
    if (disambiguation) parts.push(`from ${spellSquare(disambiguation)}`);
  } else if (capture && disambiguation) {
    parts.push(`${FILE_WORDS[disambiguation] ?? disambiguation} pawn`);
  } else {
    parts.push("pawn");
  }

  parts.push(capture ? "takes" : "to");
  parts.push(spellSquare(target));

  if (promotion) parts.push(`promoting to a ${PIECE_WORDS[promotion] ?? promotion}`);
  if (suffix === "+") parts.push(", check");
  if (suffix === "#") parts.push(", checkmate");

  return parts.join(" ").replace(" , ", ", ");
}

/** "d4" -> "d four"; "b" -> "b file"; "3" -> "the third rank". */
function spellSquare(text: string): string {
  if (/^[a-h][1-8]$/.test(text)) return `${text[0]} ${numberWord(text[1]!)}`;
  if (/^[a-h]$/.test(text)) return `the ${text} file`;
  if (/^[1-8]$/.test(text)) return `the ${numberWord(text)} rank`;
  return text;
}

const NUMBER_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight"];

function numberWord(digit: string): string {
  return NUMBER_WORDS[Number(digit)] ?? digit;
}

/** Turns a SAN line into a spoken sequence: "knight takes d4, then queen to h5". */
export function sanLineToSpeech(line: string[], limit = 4): string {
  const spoken = line.slice(0, limit).map(sanToSpeech);
  if (spoken.length === 0) return "";
  if (spoken.length === 1) return spoken[0]!;
  return `${spoken.slice(0, -1).join(", then ")}, then ${spoken[spoken.length - 1]}`;
}
