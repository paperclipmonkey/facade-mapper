# Where the sounds came from

Every clip in this folder is **CC0 / public domain**. No attribution is
required for any of them, and the app ships no credit screen; this file is the
record, so that a year from now nobody has to wonder whether a sound can stay.

All of them were topped and tailed, faded, mixed down to mono and normalised to
−1.5 dBFS, then encoded as 44.1 kHz VBR MP3. The whole folder is about 660 kB.

**Every clip starts on its own transient**, which matters more than anything
else here. Field recordings of thunder begin with a second of approaching
weather, and the first cut of these kept it: the app scheduled each clap on
the exact sample of its flash, and it was still heard a third of a second to a
second late, because that is where the crack was inside the file. They are now
cut so the strike is the first thing in them — audible within thirty
milliseconds, where a quarter of a second is heard as a fault. Replace one and
cut it the same way.

## Thunder

Three claps by **Joseph SARDIN**, [BigSoundBank](https://bigsoundbank.com),
released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
("do what you want"). All three are dry single strikes recorded without rain,
which is what makes them usable here — the show brings its own weather, and a
clap with somebody else's rain under it cannot be laid over it. They were
chosen out of eleven on how fast they get loud, because a clap that takes half
a second to arrive feels late however it is scheduled.

| File | Source | What it is |
| --- | --- | --- |
| `thunder-crack.mp3` | [Thunder #6](https://bigsoundbank.com/thunder-6-s3179.html) | A near strike: thirty milliseconds from nothing to loud, and the cleanest of the set. |
| `thunder-close.mp3` | [Thunder #7](https://bigsoundbank.com/thunder-7-s3180.html) | Almost as sharp, with a bigger swell behind it. The other near strike, so the storm does not repeat. |
| `thunder-roll.mp3` | [Thunder #8](https://bigsoundbank.com/thunder-8-s3181.html) | The big one: twenty-eight seconds, mostly dying away. Used for distant strikes. |

## Bricks falling

From [Freesound](https://freesound.org), all CC0.

| File | Source |
| --- | --- |
| `brick-1.mp3`, `brick-2.mp3`, `brick-3.mp3` | single stones, from [*recording-stenen*](https://freesound.org/s/462690/) by **bjschoen** |
| `brick-4.mp3` | [*Bag of rubble being tossed*](https://freesound.org/s/691986/) by **Sadiquecat** |
| `rubble-1.mp3` | [*Stones Falling*](https://freesound.org/s/567251/) by **iwanPlays** |
| `rubble-2.mp3` | [*Rubble shifting*](https://freesound.org/s/462162/) by **Briarheart02** |

## Tentacles slithering

From [Freesound](https://freesound.org), all CC0. Four separate wet movements
cut out of one long recording of somebody squeezing a ball of slime, and one
darker, heavier one.

| File | Source |
| --- | --- |
| `slither-1.mp3` … `slither-4.mp3` | [*Squeezing a Slime Ball*](https://freesound.org/s/666969/) by **niittymaa** |
| `slither-5.mp3` | [*Flesh being squelched*](https://freesound.org/s/595472/) by **SavReese** |

## Replacing one

The voices in [`js/core/soundscape.js`](../js/core/soundscape.js) ask for clips
by name, so a better recording can be dropped in over any file here without
touching the code. Keep it mono and keep the peak near −1.5 dBFS, or it will
sit at the wrong level against the others.
