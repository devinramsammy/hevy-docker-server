import express from "express";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const ENV_FILE_PATH = path.join(process.cwd(), ".env");

if (fs.existsSync(ENV_FILE_PATH)) {
  process.loadEnvFile?.(ENV_FILE_PATH);
}

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH =
  process.env.DB_PATH ?? path.join(process.cwd(), "data", "hevy.db");
const HEVY_API_KEY = process.env.HEVY_API_KEY ?? "";
const WEBHOOK_AUTH_TOKEN = process.env.WEBHOOK_AUTH_TOKEN ?? "";
const HEVY_API_BASE_URL = "https://api.hevyapp.com/v1";

type HevySet = {
  index: number;
  weight_kg: number | null;
  reps: number | null;
};

type HevyExercise = {
  index: number;
  title: string;
  sets: HevySet[];
};

type HevyWorkout = {
  id: string;
  title: string;
  start_time: string | null;
  end_time: string | null;
  created_at: string | null;
  updated_at: string | null;
  exercises: HevyExercise[];
};

type HevyWorkoutsPage = {
  page: number;
  page_count: number;
  workouts: HevyWorkout[];
};

type WorkoutRow = {
  id: string;
  title: string;
  start_time: string | null;
  end_time: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type ExerciseRow = {
  id: number;
  workout_id: string;
  exercise_index: number;
  title: string;
};

type SetRow = {
  exercise_id: number;
  set_index: number;
  weight_kg: number | null;
  reps: number | null;
};

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

db.exec(`

  CREATE TABLE IF NOT EXISTS workouts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id TEXT NOT NULL,
    exercise_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exercise_id INTEGER NOT NULL,
    set_index INTEGER NOT NULL,
    weight_kg REAL,
    reps INTEGER,
    FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workouts_time
    ON workouts(start_time DESC, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_exercises_title
    ON exercises(title COLLATE NOCASE);

  CREATE INDEX IF NOT EXISTS idx_exercises_workout
    ON exercises(workout_id);
`);

const upsertWorkout = db.prepare(`
  INSERT INTO workouts (id, title, start_time, end_time, created_at, updated_at)
  VALUES (@id, @title, @start_time, @end_time, @created_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    start_time = excluded.start_time,
    end_time = excluded.end_time,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
`);

const deleteExercisesForWorkout = db.prepare(
  `DELETE FROM exercises WHERE workout_id = ?`,
);
const insertExercise = db.prepare(`
  INSERT INTO exercises (workout_id, exercise_index, title)
  VALUES (?, ?, ?)
`);
const insertSet = db.prepare(`
  INSERT INTO sets (exercise_id, set_index, weight_kg, reps)
  VALUES (?, ?, ?, ?)
`);

const listStoredWorkouts = db.prepare(`
  SELECT id, title, start_time, end_time, created_at, updated_at
  FROM workouts
  ORDER BY start_time DESC, created_at DESC, id DESC
`);
const listStoredExercises = db.prepare(`
  SELECT id, workout_id, exercise_index, title
  FROM exercises
  ORDER BY workout_id ASC, exercise_index ASC, id ASC
`);
const listStoredSets = db.prepare(`
  SELECT exercise_id, set_index, weight_kg, reps
  FROM sets
  ORDER BY exercise_id ASC, set_index ASC
`);

const getLatestWorkoutRow = db.prepare(`
  SELECT id, title, start_time, end_time, created_at, updated_at
  FROM workouts
  ORDER BY start_time DESC, created_at DESC, id DESC
  LIMIT 1
`);

const listExercisesForWorkout = db.prepare(`
  SELECT id, workout_id, exercise_index, title
  FROM exercises
  WHERE workout_id = ?
  ORDER BY exercise_index ASC, id ASC
`);

const listSetsForWorkout = db.prepare(`
  SELECT s.exercise_id, s.set_index, s.weight_kg, s.reps
  FROM sets s
  JOIN exercises e ON s.exercise_id = e.id
  WHERE e.workout_id = ?
  ORDER BY s.exercise_id ASC, s.set_index ASC
`);

type ExerciseSessionRow = {
  workout_id: string;
  workout_title: string;
  date: string | null;
  exercise_id: number;
  exercise_title: string;
};

const listExerciseSessionsByTitle = db.prepare(`
  SELECT w.id AS workout_id,
         w.title AS workout_title,
         COALESCE(w.start_time, w.created_at) AS date,
         e.id AS exercise_id,
         e.title AS exercise_title
  FROM exercises e
  JOIN workouts w ON e.workout_id = w.id
  WHERE e.title = ? COLLATE NOCASE
  ORDER BY COALESCE(w.start_time, w.created_at) DESC
  LIMIT ?
`);


const storeWorkouts = db.transaction((workouts: HevyWorkout[]) => {
  for (const workout of workouts) {
    upsertWorkout.run({
      id: workout.id,
      title: workout.title,
      start_time: workout.start_time,
      end_time: workout.end_time,
      created_at: workout.created_at,
      updated_at: workout.updated_at,
    });

    deleteExercisesForWorkout.run(workout.id);

    for (const exercise of workout.exercises) {
      const exerciseResult = insertExercise.run(
        workout.id,
        exercise.index,
        exercise.title,
      );
      const exerciseId = Number(exerciseResult.lastInsertRowid);

      for (const set of exercise.sets) {
        insertSet.run(exerciseId, set.index, set.weight_kg, set.reps);
      }
    }
  }
});

const app = express();
app.set("trust proxy", 1);

app.use(
  morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"),
);

const windowMs = 15 * 60 * 1000;
const maxPerIp = Number(process.env.RATE_LIMIT_MAX_PER_IP) || 300;

app.use(
  rateLimit({
    windowMs,
    limit: maxPerIp,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use(express.json({ limit: "2mb" }));

function requireHevyApiKey(): string {
  if (!HEVY_API_KEY) {
    throw new Error("HEVY_API_KEY environment variable is required for sync");
  }

  return HEVY_API_KEY;
}

function requireWebhookAuthToken(): string {
  if (!WEBHOOK_AUTH_TOKEN) {
    throw new Error(
      "WEBHOOK_AUTH_TOKEN environment variable is required for webhook access",
    );
  }

  return WEBHOOK_AUTH_TOKEN;
}

async function fetchHevy<T>(
  resourcePath: string,
  query: Record<string, string | number> = {},
): Promise<T> {
  const apiKey = requireHevyApiKey();
  const url = new URL(resourcePath, `${HEVY_API_BASE_URL}/`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      "api-key": apiKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Hevy request failed (${response.status} ${response.statusText}): ${message}`,
    );
  }

  return (await response.json()) as T;
}

function getWorkoutCount(payload: Record<string, unknown>): number {
  const value = payload.workout_count;

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(
      "Hevy count response did not include a numeric workout_count",
    );
  }

  return value;
}

function getWorkoutFromResponse(payload: unknown): HevyWorkout {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Hevy single workout response was not an object");
  }

  if (
    "workout" in payload &&
    typeof payload.workout === "object" &&
    payload.workout !== null
  ) {
    return payload.workout as HevyWorkout;
  }

  if ("id" in payload && typeof payload.id === "string") {
    return payload as HevyWorkout;
  }

  throw new Error("Hevy single workout response did not include a workout");
}

function getWebhookWorkoutId(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    throw new Error("Webhook body must be a JSON object");
  }

  const { workoutId } = body as { workoutId?: unknown };

  if (typeof workoutId !== "string" || workoutId.trim() === "") {
    throw new Error("Webhook body must include a non-empty workoutId");
  }

  return workoutId;
}


function getAuthorizationSecret(headerValue: string | undefined): string | null {
  if (!headerValue?.trim()) {
    return null;
  }

  const parts = headerValue.trim().split(/\s+/);

  if (parts[0] === "Bearer") {
    if (parts.length < 2) {
      return null;
    }
    return parts.slice(1).join(" ");
  }

  if (parts.length === 1) {
    return parts[0] ?? null;
  }

  return null;
}

async function syncWorkoutsFromHevy() {
  const countResponse =
    await fetchHevy<Record<string, unknown>>("workouts/count");
  const workoutCount = getWorkoutCount(countResponse);

  if (workoutCount === 0) {
    return {
      workout_count: 0,
      page_count: 0,
      synced_workouts: 0,
    };
  }

  let page = 1;
  let pageCount = 1;
  let syncedWorkouts = 0;

  while (page <= pageCount) {
    const pageResponse = await fetchHevy<HevyWorkoutsPage>("workouts", {
      page,
    });

    pageCount = pageResponse.page_count;
    storeWorkouts(pageResponse.workouts);
    syncedWorkouts += pageResponse.workouts.length;
    page += 1;
  }

  return {
    workout_count: workoutCount,
    page_count: pageCount,
    synced_workouts: syncedWorkouts,
  };
}

async function syncWorkoutByIdFromHevy(workoutId: string) {
  const response = await fetchHevy<unknown>(`workouts/${workoutId}`);
  const workout = getWorkoutFromResponse(response);
  storeWorkouts([workout]);
  return workout;
}

function groupSetsByExerciseId(sets: SetRow[]): Map<number, SetRow[]> {
  const map = new Map<number, SetRow[]>();
  for (const set of sets) {
    const existing = map.get(set.exercise_id) ?? [];
    existing.push(set);
    map.set(set.exercise_id, existing);
  }
  return map;
}

type ExerciseWithSets = ExerciseRow & {
  sets: Array<{
    set_index: number;
    weight_kg: number | null;
    reps: number | null;
  }>;
};

function nestExercisesWithSets(
  exercises: ExerciseRow[],
  setsByExerciseId: Map<number, SetRow[]>,
): ExerciseWithSets[] {
  return exercises.map((exercise) => ({
    ...exercise,
    sets: (setsByExerciseId.get(exercise.id) ?? []).map((set) => ({
      set_index: set.set_index,
      weight_kg: set.weight_kg,
      reps: set.reps,
    })),
  }));
}

function getSetsForExerciseIds(exerciseIds: number[]): SetRow[] {
  if (exerciseIds.length === 0) {
    return [];
  }
  const placeholders = exerciseIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    SELECT exercise_id, set_index, weight_kg, reps
    FROM sets
    WHERE exercise_id IN (${placeholders})
    ORDER BY exercise_id ASC, set_index ASC
  `);
  return stmt.all(...exerciseIds) as SetRow[];
}

function buildWorkoutResponse() {
  const workouts = listStoredWorkouts.all() as WorkoutRow[];
  const exercises = listStoredExercises.all() as ExerciseRow[];
  const sets = listStoredSets.all() as SetRow[];

  const setsByExerciseId = groupSetsByExerciseId(sets);

  const exercisesByWorkoutId = new Map<string, ExerciseRow[]>();

  for (const exercise of exercises) {
    const existing = exercisesByWorkoutId.get(exercise.workout_id) ?? [];
    existing.push(exercise);
    exercisesByWorkoutId.set(exercise.workout_id, existing);
  }

  return workouts.map((workout) => ({
    ...workout,
    exercises: nestExercisesWithSets(
      exercisesByWorkoutId.get(workout.id) ?? [],
      setsByExerciseId,
    ),
  }));
}

function buildLatestWorkoutResponse(): (WorkoutRow & { exercises: ExerciseWithSets[] }) | null {
  const workout = getLatestWorkoutRow.get() as WorkoutRow | undefined;
  if (!workout) {
    return null;
  }
  const exercises = listExercisesForWorkout.all(workout.id) as ExerciseRow[];
  const sets = listSetsForWorkout.all(workout.id) as SetRow[];
  const setsByExerciseId = groupSetsByExerciseId(sets);
  return {
    ...workout,
    exercises: nestExercisesWithSets(exercises, setsByExerciseId),
  };
}

function parseHistoryLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return 5;
  }
  const value =
    typeof raw === "string"
      ? Number.parseInt(raw, 10)
      : typeof raw === "number"
        ? raw
        : Number.NaN;
  if (!Number.isFinite(value) || value < 1) {
    return 5;
  }
  return Math.min(20, Math.floor(value));
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/webhook", (req, res) => {
  try {
    const expectedToken = requireWebhookAuthToken();
    const providedToken = getAuthorizationSecret(req.get("authorization"));

    if (providedToken !== expectedToken) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const workoutId = getWebhookWorkoutId(req.body);

    res.status(200).json({
      ok: true,
      accepted: true,
      workout_id: workoutId,
    });

    void syncWorkoutByIdFromHevy(workoutId).catch((error) => {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown error during webhook sync";
      console.error(
        `[webhook] background sync failed workoutId=${workoutId}:`,
        message,
      );
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown error during webhook validation";
    res.status(500).json({ ok: false, error: message });
  }
});

app.post("/sync", async (_req, res) => {
  try {
    const summary = await syncWorkoutsFromHevy();
    res.json({ ok: true, ...summary });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error during sync";
    res.status(500).json({ ok: false, error: message });
  }
});

app.get("/workouts/latest", (_req, res) => {
  const workout = buildLatestWorkoutResponse();
  if (!workout) {
    res.status(404).json({ ok: false, error: "No workouts found" });
    return;
  }
  res.json(workout);
});

app.get("/exercises/:title/history", (req, res) => {
  const title = req.params.title ?? "";
  const limitRaw = req.query.limit;
  const limitParam = Array.isArray(limitRaw) ? limitRaw[0] : limitRaw;
  const limit = parseHistoryLimit(limitParam);

  const rows = listExerciseSessionsByTitle.all(
    title,
    limit,
  ) as ExerciseSessionRow[];

  const exerciseIds = rows.map((row) => row.exercise_id);
  const sets = getSetsForExerciseIds(exerciseIds);
  const setsByExerciseId = groupSetsByExerciseId(sets);

  const sessions = rows.map((row) => ({
    workout_id: row.workout_id,
    workout_title: row.workout_title,
    date: row.date,
    sets: (setsByExerciseId.get(row.exercise_id) ?? []).map((set) => ({
      set_index: set.set_index,
      weight_kg: set.weight_kg,
      reps: set.reps,
    })),
  }));

  res.json({
    exercise: rows.length > 0 ? rows[0].exercise_title : title,
    sessions,
  });
});

app.get("/workouts", (_req, res) => {
  res.json({ items: buildWorkoutResponse() });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}, db=${DB_PATH}`);
});
