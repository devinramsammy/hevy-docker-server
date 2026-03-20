import express from "express";
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

function getBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null;
  }

  const [scheme, token, ...rest] = headerValue.trim().split(/\s+/);

  if (scheme !== "Bearer" || !token || rest.length > 0) {
    return null;
  }

  return token;
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

function buildWorkoutResponse() {
  const workouts = listStoredWorkouts.all() as WorkoutRow[];
  const exercises = listStoredExercises.all() as ExerciseRow[];
  const sets = listStoredSets.all() as SetRow[];

  const setsByExerciseId = new Map<number, SetRow[]>();
  for (const set of sets) {
    const existing = setsByExerciseId.get(set.exercise_id) ?? [];
    existing.push(set);
    setsByExerciseId.set(set.exercise_id, existing);
  }

  const exercisesByWorkoutId = new Map<
    string,
    Array<ExerciseRow & { sets: Array<Omit<SetRow, "exercise_id">> }>
  >();

  for (const exercise of exercises) {
    const existing = exercisesByWorkoutId.get(exercise.workout_id) ?? [];
    existing.push({
      ...exercise,
      sets: (setsByExerciseId.get(exercise.id) ?? []).map((set) => ({
        set_index: set.set_index,
        weight_kg: set.weight_kg,
        reps: set.reps,
      })),
    });
    exercisesByWorkoutId.set(exercise.workout_id, existing);
  }

  return workouts.map((workout) => ({
    ...workout,
    exercises: exercisesByWorkoutId.get(workout.id) ?? [],
  }));
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/webhook", async (req, res) => {
  try {
    const expectedToken = requireWebhookAuthToken();
    const providedToken = getBearerToken(req.get("authorization"));

    if (providedToken !== expectedToken) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const workoutId = getWebhookWorkoutId(req.body);
    const workout = await syncWorkoutByIdFromHevy(workoutId);

    res.status(200).json({
      ok: true,
      workout_id: workout.id,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown error during webhook sync";
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

app.get("/workouts", (_req, res) => {
  res.json({ items: buildWorkoutResponse() });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}, db=${DB_PATH}`);
});
