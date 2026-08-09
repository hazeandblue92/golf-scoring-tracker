-- Migration 4: course tables (spec section 11.4).

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete restrict,
  name text not null,
  location_text text,
  timezone text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.course_layouts (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete restrict,
  name text not null,
  hole_count smallint not null check (hole_count in (9, 18)),
  version integer not null default 1,
  effective_from date,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint course_layouts_unique unique (course_id, name, version)
);

-- Slope check 55..155 is the WHS profile bound (section 11.4). A
-- committee_custom profile may widen it only via a reviewed migration and
-- must surface an engine warning.
create table public.tee_sets (
  id uuid primary key default gen_random_uuid(),
  course_layout_id uuid not null references public.course_layouts (id) on delete restrict,
  name text not null,
  rating_category text,
  course_rating numeric(5, 1) not null,
  slope_rating smallint not null check (slope_rating between 55 and 155),
  par smallint not null check (par > 0),
  version integer not null default 1,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tee_sets_unique unique (course_layout_id, name, version)
);

-- Per-hole data for a tee set. Composite PK (tee_set_id, hole_ordinal);
-- stroke indexes must be unique within a tee set (preflight also blocks
-- duplicate stroke indexes at publish, section 3.2).
create table public.tee_holes (
  tee_set_id uuid not null references public.tee_sets (id) on delete restrict,
  hole_ordinal smallint not null check (hole_ordinal between 1 and 18),
  course_hole_label text,
  par smallint not null check (par between 3 and 6),
  yardage smallint check (yardage is null or yardage > 0),
  stroke_index smallint not null check (stroke_index between 1 and 18),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tee_set_id, hole_ordinal),
  constraint tee_holes_stroke_index_unique unique (tee_set_id, stroke_index)
);
