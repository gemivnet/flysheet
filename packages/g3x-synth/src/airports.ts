/**
 * Airport geometry used by the scenarios. Coordinates are realistic (KLOT
 * Lewis University, KIKK Greater Kankakee) and consistent with the trimmed
 * NASR fixture used by the server tests — synthetic flights must land on
 * runways the enrichment step can associate.
 */

export interface RunwayEnd {
  airport: string;
  ident: string;
  thrLat: number;
  thrLon: number;
  elevFt: number;
  /** Direction of takeoff/landing on this end, degrees true. */
  headingTrue: number;
  lengthFt: number;
}

export interface Airport {
  ident: string;
  name: string;
  lat: number;
  lon: number;
  elevFt: number;
  runwayEnds: RunwayEnd[];
}

const KLOT_ELEV = 679;
const KIKK_ELEV = 630;

export const KLOT: Airport = {
  ident: 'KLOT',
  name: 'Lewis University',
  lat: 41.6073,
  lon: -88.0962,
  elevFt: KLOT_ELEV,
  runwayEnds: [
    // 6500 ft runway 09/27. Threshold 27 is the EAST end; landing 27 means
    // flying heading 270 (approach from the east).
    {
      airport: 'KLOT',
      ident: '27',
      thrLat: 41.6073,
      thrLon: -88.0835,
      elevFt: KLOT_ELEV,
      headingTrue: 270,
      lengthFt: 6500,
    },
    {
      airport: 'KLOT',
      ident: '09',
      thrLat: 41.6073,
      thrLon: -88.1072,
      elevFt: KLOT_ELEV,
      headingTrue: 90,
      lengthFt: 6500,
    },
  ],
};

export const KIKK: Airport = {
  ident: 'KIKK',
  name: 'Greater Kankakee',
  lat: 41.0714,
  lon: -87.8463,
  elevFt: KIKK_ELEV,
  runwayEnds: [
    {
      airport: 'KIKK',
      ident: '34',
      thrLat: 41.0622,
      thrLon: -87.8425,
      elevFt: KIKK_ELEV,
      headingTrue: 340,
      lengthFt: 5980,
    },
    {
      airport: 'KIKK',
      ident: '16',
      thrLat: 41.0806,
      thrLon: -87.8502,
      elevFt: KIKK_ELEV,
      headingTrue: 160,
      lengthFt: 5980,
    },
  ],
};

export const AIRPORTS: Record<string, Airport> = { KLOT, KIKK };

export function runwayEnd(airport: Airport, ident: string): RunwayEnd {
  const end = airport.runwayEnds.find((r) => r.ident === ident);
  if (!end) throw new Error(`no runway ${ident} at ${airport.ident}`);
  return end;
}
