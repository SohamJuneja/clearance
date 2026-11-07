import React from "react";
import { Composition, Still } from "remotion";
import { Film, totalFrames } from "./Film";
import { film } from "./film";
import { Thumbnail } from "./Thumbnail";

export const Root: React.FC = () => (
  <>
    <Composition id="Film" component={Film} fps={film.fps} width={film.width} height={film.height}
      durationInFrames={Math.max(1, totalFrames(film.fps))} />
    <Still id="Thumbnail" component={Thumbnail} width={1280} height={720} />
  </>
);
