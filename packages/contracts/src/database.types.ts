/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by `npm run db:types` from the applied migrations in
 * supabase/migrations. CI regenerates it against a freshly migrated database
 * and fails when this file does not match, so a schema change that forgot the
 * regeneration step cannot merge.
 *
 * These are row shapes, not authorization. What a role may actually read or
 * write is decided by RLS and the table grants in the migrations; a column
 * appearing here says nothing about who can see it.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      app_error_events: {
        Row: {
          correlation_id: string | null
          error_code: string
          first_seen_at: string
          id: string
          last_seen_at: string
          occurrence_count: number
          release: string | null
          route_family: string | null
          severity: string
          window_started_at: string
        }
        Insert: {
          correlation_id?: string | null
          error_code: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          occurrence_count?: number
          release?: string | null
          route_family?: string | null
          severity?: string
          window_started_at?: string
        }
        Update: {
          correlation_id?: string | null
          error_code?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          occurrence_count?: number
          release?: string | null
          route_family?: string | null
          severity?: string
          window_started_at?: string
        }
        Relationships: []
      }
      audit_events: {
        Row: {
          action: string
          actor_profile_id: string | null
          after_json: Json | null
          before_json: Json | null
          correlation_id: string | null
          created_at: string
          id: string
          reason: string | null
          scope_event_id: string | null
          scope_league_id: string | null
          target_id: string | null
          target_type: string
        }
        Insert: {
          action: string
          actor_profile_id?: string | null
          after_json?: Json | null
          before_json?: Json | null
          correlation_id?: string | null
          created_at?: string
          id?: string
          reason?: string | null
          scope_event_id?: string | null
          scope_league_id?: string | null
          target_id?: string | null
          target_type: string
        }
        Update: {
          action?: string
          actor_profile_id?: string | null
          after_json?: Json | null
          before_json?: Json | null
          correlation_id?: string | null
          created_at?: string
          id?: string
          reason?: string | null
          scope_event_id?: string | null
          scope_league_id?: string | null
          target_id?: string | null
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_actor_profile_id_fkey"
            columns: ["actor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_events_scope_event_id_fkey"
            columns: ["scope_event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_events_scope_league_id_fkey"
            columns: ["scope_league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
        ]
      }
      backup_runs: {
        Row: {
          artifact_checksum: string | null
          artifact_size_bytes: number | null
          completed_at: string | null
          created_at: string
          id: string
          last_tested_restore_on: string | null
          started_at: string
          status: string
          workflow_run_url: string | null
        }
        Insert: {
          artifact_checksum?: string | null
          artifact_size_bytes?: number | null
          completed_at?: string | null
          created_at?: string
          id?: string
          last_tested_restore_on?: string | null
          started_at: string
          status?: string
          workflow_run_url?: string | null
        }
        Update: {
          artifact_checksum?: string | null
          artifact_size_bytes?: number | null
          completed_at?: string | null
          created_at?: string
          id?: string
          last_tested_restore_on?: string | null
          started_at?: string
          status?: string
          workflow_run_url?: string | null
        }
        Relationships: []
      }
      competition_entities: {
        Row: {
          competition_id: string
          created_at: string
          eligibility_status: string
          event_entry_id: string | null
          event_team_id: string | null
          flight_id: string | null
          id: string
          seed: number | null
          updated_at: string
        }
        Insert: {
          competition_id: string
          created_at?: string
          eligibility_status?: string
          event_entry_id?: string | null
          event_team_id?: string | null
          flight_id?: string | null
          id?: string
          seed?: number | null
          updated_at?: string
        }
        Update: {
          competition_id?: string
          created_at?: string
          eligibility_status?: string
          event_entry_id?: string | null
          event_team_id?: string | null
          flight_id?: string | null
          id?: string
          seed?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "competition_entities_competition_id_fkey"
            columns: ["competition_id"]
            isOneToOne: false
            referencedRelation: "competitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competition_entities_event_entry_id_fkey"
            columns: ["event_entry_id"]
            isOneToOne: false
            referencedRelation: "event_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competition_entities_event_team_id_fkey"
            columns: ["event_team_id"]
            isOneToOne: false
            referencedRelation: "event_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competition_entities_flight_id_fkey"
            columns: ["flight_id"]
            isOneToOne: false
            referencedRelation: "flights"
            referencedColumns: ["id"]
          },
        ]
      }
      competition_projections: {
        Row: {
          calculated_at: string
          competition_id: string
          engine_version: string
          event_revision: number
          projection_hash: string
          status: string
          summary_json: Json
          warnings: Json
        }
        Insert: {
          calculated_at?: string
          competition_id: string
          engine_version: string
          event_revision: number
          projection_hash: string
          status?: string
          summary_json?: Json
          warnings?: Json
        }
        Update: {
          calculated_at?: string
          competition_id?: string
          engine_version?: string
          event_revision?: number
          projection_hash?: string
          status?: string
          summary_json?: Json
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "competition_projections_competition_id_fkey"
            columns: ["competition_id"]
            isOneToOne: false
            referencedRelation: "competitions"
            referencedColumns: ["id"]
          },
        ]
      }
      competition_rounds: {
        Row: {
          competition_id: string
          created_at: string
          drop_policy: string | null
          hole_scope: number[] | null
          round_id: string
          weight: number
        }
        Insert: {
          competition_id: string
          created_at?: string
          drop_policy?: string | null
          hole_scope?: number[] | null
          round_id: string
          weight?: number
        }
        Update: {
          competition_id?: string
          created_at?: string
          drop_policy?: string | null
          hole_scope?: number[] | null
          round_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "competition_rounds_competition_id_fkey"
            columns: ["competition_id"]
            isOneToOne: false
            referencedRelation: "competitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competition_rounds_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      competitions: {
        Row: {
          created_at: string
          engine_version: string
          event_id: string
          final_result_hash: string | null
          finalized_at: string | null
          finalized_by: string | null
          finalized_revision: number | null
          format: string
          id: string
          metric: string
          name: string
          rules_json: Json
          rules_schema_version: number
          rules_text: string
          sort_order: number
          status: string
          updated_at: string
          visibility: Database["public"]["Enums"]["event_visibility"]
        }
        Insert: {
          created_at?: string
          engine_version: string
          event_id: string
          final_result_hash?: string | null
          finalized_at?: string | null
          finalized_by?: string | null
          finalized_revision?: number | null
          format: string
          id?: string
          metric: string
          name: string
          rules_json: Json
          rules_schema_version?: number
          rules_text?: string
          sort_order?: number
          status?: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["event_visibility"]
        }
        Update: {
          created_at?: string
          engine_version?: string
          event_id?: string
          final_result_hash?: string | null
          finalized_at?: string | null
          finalized_by?: string | null
          finalized_revision?: number | null
          format?: string
          id?: string
          metric?: string
          name?: string
          rules_json?: Json
          rules_schema_version?: number
          rules_text?: string
          sort_order?: number
          status?: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["event_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "competitions_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competitions_finalized_by_fkey"
            columns: ["finalized_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      course_layouts: {
        Row: {
          course_id: string
          created_at: string
          effective_from: string | null
          hole_count: number
          id: string
          name: string
          retired_at: string | null
          updated_at: string
          version: number
        }
        Insert: {
          course_id: string
          created_at?: string
          effective_from?: string | null
          hole_count: number
          id?: string
          name: string
          retired_at?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          course_id?: string
          created_at?: string
          effective_from?: string | null
          hole_count?: number
          id?: string
          name?: string
          retired_at?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "course_layouts_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      courses: {
        Row: {
          created_at: string
          id: string
          league_id: string
          location_text: string | null
          name: string
          status: string
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          league_id: string
          location_text?: string | null
          name: string
          status?: string
          timezone: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          league_id?: string
          location_text?: string | null
          name?: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "courses_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
        ]
      }
      event_entries: {
        Row: {
          allowance: number | null
          course_handicap_unrounded: number | null
          created_at: string
          effective_from_round_id: string | null
          event_id: string
          flight_id: string | null
          handicap_profile: string | null
          handicap_source: Database["public"]["Enums"]["handicap_source"]
          handicap_value: number | null
          id: string
          participant_id: string
          playing_handicap: number | null
          replaces_entry_id: string | null
          seed: number | null
          snapshot_hash: string | null
          status: Database["public"]["Enums"]["entity_status"]
          substitution_reason: string | null
          tee_snapshot_id: string | null
          updated_at: string
        }
        Insert: {
          allowance?: number | null
          course_handicap_unrounded?: number | null
          created_at?: string
          effective_from_round_id?: string | null
          event_id: string
          flight_id?: string | null
          handicap_profile?: string | null
          handicap_source?: Database["public"]["Enums"]["handicap_source"]
          handicap_value?: number | null
          id?: string
          participant_id: string
          playing_handicap?: number | null
          replaces_entry_id?: string | null
          seed?: number | null
          snapshot_hash?: string | null
          status?: Database["public"]["Enums"]["entity_status"]
          substitution_reason?: string | null
          tee_snapshot_id?: string | null
          updated_at?: string
        }
        Update: {
          allowance?: number | null
          course_handicap_unrounded?: number | null
          created_at?: string
          effective_from_round_id?: string | null
          event_id?: string
          flight_id?: string | null
          handicap_profile?: string | null
          handicap_source?: Database["public"]["Enums"]["handicap_source"]
          handicap_value?: number | null
          id?: string
          participant_id?: string
          playing_handicap?: number | null
          replaces_entry_id?: string | null
          seed?: number | null
          snapshot_hash?: string | null
          status?: Database["public"]["Enums"]["entity_status"]
          substitution_reason?: string | null
          tee_snapshot_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_entries_effective_from_round_id_fkey"
            columns: ["effective_from_round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_entries_effective_round_same_event_fk"
            columns: ["effective_from_round_id", "event_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id", "event_id"]
          },
          {
            foreignKeyName: "event_entries_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_entries_flight_id_fkey"
            columns: ["flight_id"]
            isOneToOne: false
            referencedRelation: "flights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_entries_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_entries_replacement_same_event_fk"
            columns: ["replaces_entry_id", "event_id"]
            isOneToOne: false
            referencedRelation: "event_entries"
            referencedColumns: ["id", "event_id"]
          },
          {
            foreignKeyName: "event_entries_replaces_entry_id_fkey"
            columns: ["replaces_entry_id"]
            isOneToOne: false
            referencedRelation: "event_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_entries_tee_snapshot_id_fkey"
            columns: ["tee_snapshot_id"]
            isOneToOne: false
            referencedRelation: "event_tee_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      event_holes: {
        Row: {
          created_at: string
          event_tee_snapshot_id: string
          hole_ordinal: number
          id: string
          label: string | null
          par: number
          round_id: string
          stroke_index: number
          yardage: number | null
        }
        Insert: {
          created_at?: string
          event_tee_snapshot_id: string
          hole_ordinal: number
          id?: string
          label?: string | null
          par: number
          round_id: string
          stroke_index: number
          yardage?: number | null
        }
        Update: {
          created_at?: string
          event_tee_snapshot_id?: string
          hole_ordinal?: number
          id?: string
          label?: string | null
          par?: number
          round_id?: string
          stroke_index?: number
          yardage?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "event_holes_event_tee_snapshot_id_fkey"
            columns: ["event_tee_snapshot_id"]
            isOneToOne: false
            referencedRelation: "event_tee_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_holes_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      event_revision_feed: {
        Row: {
          changed_competition_ids: string[]
          event_id: string
          id: string
          projection_revision: number
          published_at: string
          score_revision: number
        }
        Insert: {
          changed_competition_ids?: string[]
          event_id: string
          id?: string
          projection_revision: number
          published_at?: string
          score_revision: number
        }
        Update: {
          changed_competition_ids?: string[]
          event_id?: string
          id?: string
          projection_revision?: number
          published_at?: string
          score_revision?: number
        }
        Relationships: [
          {
            foreignKeyName: "event_revision_feed_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_team_members: {
        Row: {
          created_at: string
          event_entry_id: string
          event_team_id: string
          id: string
          position: number
        }
        Insert: {
          created_at?: string
          event_entry_id: string
          event_team_id: string
          id?: string
          position?: number
        }
        Update: {
          created_at?: string
          event_entry_id?: string
          event_team_id?: string
          id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "event_team_members_event_entry_id_fkey"
            columns: ["event_entry_id"]
            isOneToOne: false
            referencedRelation: "event_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_team_members_event_team_id_fkey"
            columns: ["event_team_id"]
            isOneToOne: false
            referencedRelation: "event_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      event_teams: {
        Row: {
          allowance: number | null
          course_handicap_unrounded: number | null
          created_at: string
          event_id: string
          flight_id: string | null
          id: string
          name: string
          playing_handicap: number | null
          seed: number | null
          snapshot_hash: string | null
          source_team_id: string | null
          status: Database["public"]["Enums"]["entity_status"]
          updated_at: string
        }
        Insert: {
          allowance?: number | null
          course_handicap_unrounded?: number | null
          created_at?: string
          event_id: string
          flight_id?: string | null
          id?: string
          name: string
          playing_handicap?: number | null
          seed?: number | null
          snapshot_hash?: string | null
          source_team_id?: string | null
          status?: Database["public"]["Enums"]["entity_status"]
          updated_at?: string
        }
        Update: {
          allowance?: number | null
          course_handicap_unrounded?: number | null
          created_at?: string
          event_id?: string
          flight_id?: string | null
          id?: string
          name?: string
          playing_handicap?: number | null
          seed?: number | null
          snapshot_hash?: string | null
          source_team_id?: string | null
          status?: Database["public"]["Enums"]["entity_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_teams_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_teams_flight_id_fkey"
            columns: ["flight_id"]
            isOneToOne: false
            referencedRelation: "flights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_teams_source_team_id_fkey"
            columns: ["source_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      event_tee_snapshots: {
        Row: {
          course_name: string
          course_rating: number
          created_at: string
          hole_count: number
          id: string
          layout_name: string
          par: number
          rating_category: string | null
          round_id: string
          slope_rating: number
          snapshot_hash: string
          snapshot_version: number
          source_tee_set_id: string
          tee_name: string
        }
        Insert: {
          course_name: string
          course_rating: number
          created_at?: string
          hole_count: number
          id?: string
          layout_name: string
          par: number
          rating_category?: string | null
          round_id: string
          slope_rating: number
          snapshot_hash: string
          snapshot_version?: number
          source_tee_set_id: string
          tee_name: string
        }
        Update: {
          course_name?: string
          course_rating?: number
          created_at?: string
          hole_count?: number
          id?: string
          layout_name?: string
          par?: number
          rating_category?: string | null
          round_id?: string
          slope_rating?: number
          snapshot_hash?: string
          snapshot_version?: number
          source_tee_set_id?: string
          tee_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_tee_snapshots_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_tee_snapshots_source_tee_set_id_fkey"
            columns: ["source_tee_set_id"]
            isOneToOne: false
            referencedRelation: "tee_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          created_at: string
          created_by: string | null
          ends_at: string | null
          id: string
          league_id: string
          name: string
          published_snapshot_version: number | null
          scoring_revision: number
          season_id: string
          slug: string
          starts_at: string
          status: Database["public"]["Enums"]["event_status"]
          timezone: string
          updated_at: string
          visibility: Database["public"]["Enums"]["event_visibility"]
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          id?: string
          league_id: string
          name: string
          published_snapshot_version?: number | null
          scoring_revision?: number
          season_id: string
          slug: string
          starts_at: string
          status?: Database["public"]["Enums"]["event_status"]
          timezone: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["event_visibility"]
        }
        Update: {
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          id?: string
          league_id?: string
          name?: string
          published_snapshot_version?: number | null
          scoring_revision?: number
          season_id?: string
          slug?: string
          starts_at?: string
          status?: Database["public"]["Enums"]["event_status"]
          timezone?: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["event_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      flights: {
        Row: {
          created_at: string
          eligibility_json: Json | null
          event_id: string
          id: string
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          eligibility_json?: Json | null
          event_id: string
          id?: string
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          eligibility_json?: Json | null
          event_id?: string
          id?: string
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "flights_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      group_members: {
        Row: {
          created_at: string
          event_entry_id: string | null
          event_team_id: string | null
          group_id: string
          id: string
          sort_order: number
        }
        Insert: {
          created_at?: string
          event_entry_id?: string | null
          event_team_id?: string | null
          group_id: string
          id?: string
          sort_order?: number
        }
        Update: {
          created_at?: string
          event_entry_id?: string | null
          event_team_id?: string | null
          group_id?: string
          id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "group_members_event_entry_id_fkey"
            columns: ["event_entry_id"]
            isOneToOne: false
            referencedRelation: "event_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_members_event_team_id_fkey"
            columns: ["event_team_id"]
            isOneToOne: false
            referencedRelation: "event_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          created_at: string
          id: string
          label: string
          marker_profile_id: string | null
          round_id: string
          sort_order: number
          start_hole_ordinal: number | null
          starts_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          label: string
          marker_profile_id?: string | null
          round_id: string
          sort_order?: number
          start_hole_ordinal?: number | null
          starts_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string
          marker_profile_id?: string | null
          round_id?: string
          sort_order?: number
          start_hole_ordinal?: number | null
          starts_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "groups_marker_profile_id_fkey"
            columns: ["marker_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "groups_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      hole_results: {
        Row: {
          competition_id: string
          contributor_entry_ids: string[] | null
          created_at: string
          detail_json: Json | null
          entity_id: string
          event_hole_id: string
          event_revision: number
          gross: number | null
          id: string
          match_result: string | null
          net: number | null
          provisional: boolean
          relative_to_par: number | null
          skin_carried_units: number | null
          skin_units: number | null
          skin_winner: boolean | null
          status: Database["public"]["Enums"]["score_status"] | null
          strokes_received: number | null
        }
        Insert: {
          competition_id: string
          contributor_entry_ids?: string[] | null
          created_at?: string
          detail_json?: Json | null
          entity_id: string
          event_hole_id: string
          event_revision: number
          gross?: number | null
          id?: string
          match_result?: string | null
          net?: number | null
          provisional?: boolean
          relative_to_par?: number | null
          skin_carried_units?: number | null
          skin_units?: number | null
          skin_winner?: boolean | null
          status?: Database["public"]["Enums"]["score_status"] | null
          strokes_received?: number | null
        }
        Update: {
          competition_id?: string
          contributor_entry_ids?: string[] | null
          created_at?: string
          detail_json?: Json | null
          entity_id?: string
          event_hole_id?: string
          event_revision?: number
          gross?: number | null
          id?: string
          match_result?: string | null
          net?: number | null
          provisional?: boolean
          relative_to_par?: number | null
          skin_carried_units?: number | null
          skin_units?: number | null
          skin_winner?: boolean | null
          status?: Database["public"]["Enums"]["score_status"] | null
          strokes_received?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "hole_results_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "competition_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hole_results_event_hole_id_fkey"
            columns: ["event_hole_id"]
            isOneToOne: false
            referencedRelation: "event_holes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hole_results_projection_fk"
            columns: ["competition_id", "event_revision"]
            isOneToOne: false
            referencedRelation: "competition_projections"
            referencedColumns: ["competition_id", "event_revision"]
          },
        ]
      }
      individual_hole_scores: {
        Row: {
          client_recorded_at: string | null
          created_at: string
          device_id_hash: string | null
          entered_by: string | null
          event_entry_id: string
          event_hole_id: string
          event_id: string
          gross_strokes: number | null
          id: string
          notes: string | null
          revision: number
          round_id: string
          score_status: Database["public"]["Enums"]["score_status"]
          server_recorded_at: string
          source: string
          submitted_at: string | null
          updated_at: string
        }
        Insert: {
          client_recorded_at?: string | null
          created_at?: string
          device_id_hash?: string | null
          entered_by?: string | null
          event_entry_id: string
          event_hole_id: string
          event_id: string
          gross_strokes?: number | null
          id?: string
          notes?: string | null
          revision?: number
          round_id: string
          score_status?: Database["public"]["Enums"]["score_status"]
          server_recorded_at?: string
          source?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Update: {
          client_recorded_at?: string | null
          created_at?: string
          device_id_hash?: string | null
          entered_by?: string | null
          event_entry_id?: string
          event_hole_id?: string
          event_id?: string
          gross_strokes?: number | null
          id?: string
          notes?: string | null
          revision?: number
          round_id?: string
          score_status?: Database["public"]["Enums"]["score_status"]
          server_recorded_at?: string
          source?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "individual_hole_scores_entered_by_fkey"
            columns: ["entered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "individual_hole_scores_entry_fk"
            columns: ["event_entry_id", "event_id"]
            isOneToOne: false
            referencedRelation: "event_entries"
            referencedColumns: ["id", "event_id"]
          },
          {
            foreignKeyName: "individual_hole_scores_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "individual_hole_scores_hole_fk"
            columns: ["event_hole_id", "round_id"]
            isOneToOne: false
            referencedRelation: "event_holes"
            referencedColumns: ["id", "round_id"]
          },
          {
            foreignKeyName: "individual_hole_scores_round_fk"
            columns: ["round_id", "event_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id", "event_id"]
          },
        ]
      }
      leaderboard_rows: {
        Row: {
          competition_id: string
          created_at: string
          detail_json: Json
          display_primary: string | null
          entity_id: string
          event_revision: number
          is_tied: boolean
          rank: number | null
          result_primary: number | null
          result_secondary: number | null
          status: string
          thru: number | null
        }
        Insert: {
          competition_id: string
          created_at?: string
          detail_json?: Json
          display_primary?: string | null
          entity_id: string
          event_revision: number
          is_tied?: boolean
          rank?: number | null
          result_primary?: number | null
          result_secondary?: number | null
          status?: string
          thru?: number | null
        }
        Update: {
          competition_id?: string
          created_at?: string
          detail_json?: Json
          display_primary?: string | null
          entity_id?: string
          event_revision?: number
          is_tied?: boolean
          rank?: number | null
          result_primary?: number | null
          result_secondary?: number | null
          status?: string
          thru?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "leaderboard_rows_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "competition_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leaderboard_rows_projection_fk"
            columns: ["competition_id", "event_revision"]
            isOneToOne: false
            referencedRelation: "competition_projections"
            referencedColumns: ["competition_id", "event_revision"]
          },
        ]
      }
      league_memberships: {
        Row: {
          created_at: string
          ended_at: string | null
          id: string
          joined_at: string
          league_id: string
          member_status: Database["public"]["Enums"]["member_status"]
          profile_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          ended_at?: string | null
          id?: string
          joined_at?: string
          league_id: string
          member_status?: Database["public"]["Enums"]["member_status"]
          profile_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          ended_at?: string | null
          id?: string
          joined_at?: string
          league_id?: string
          member_status?: Database["public"]["Enums"]["member_status"]
          profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "league_memberships_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_memberships_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      leagues: {
        Row: {
          created_at: string
          id: string
          locale: string
          name: string
          privacy_notice_version: number
          settings_json: Json
          slug: string
          status: string
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          locale?: string
          name: string
          privacy_notice_version?: number
          settings_json?: Json
          slug: string
          status?: string
          timezone: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          locale?: string
          name?: string
          privacy_notice_version?: number
          settings_json?: Json
          slug?: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      matches: {
        Row: {
          bracket_position: number | null
          competition_id: string
          concession_by: string | null
          concession_reason: string | null
          created_at: string
          id: string
          result_summary: string | null
          round_id: string
          side_a_entity_id: string | null
          side_b_entity_id: string | null
          status: string
          updated_at: string
          winner_entity_id: string | null
        }
        Insert: {
          bracket_position?: number | null
          competition_id: string
          concession_by?: string | null
          concession_reason?: string | null
          created_at?: string
          id?: string
          result_summary?: string | null
          round_id: string
          side_a_entity_id?: string | null
          side_b_entity_id?: string | null
          status?: string
          updated_at?: string
          winner_entity_id?: string | null
        }
        Update: {
          bracket_position?: number | null
          competition_id?: string
          concession_by?: string | null
          concession_reason?: string | null
          created_at?: string
          id?: string
          result_summary?: string | null
          round_id?: string
          side_a_entity_id?: string | null
          side_b_entity_id?: string | null
          status?: string
          updated_at?: string
          winner_entity_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matches_competition_id_fkey"
            columns: ["competition_id"]
            isOneToOne: false
            referencedRelation: "competitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_competition_round_fk"
            columns: ["competition_id", "round_id"]
            isOneToOne: false
            referencedRelation: "competition_rounds"
            referencedColumns: ["competition_id", "round_id"]
          },
          {
            foreignKeyName: "matches_concession_by_fkey"
            columns: ["concession_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_side_a_competition_fk"
            columns: ["side_a_entity_id", "competition_id"]
            isOneToOne: false
            referencedRelation: "competition_entities"
            referencedColumns: ["id", "competition_id"]
          },
          {
            foreignKeyName: "matches_side_a_entity_id_fkey"
            columns: ["side_a_entity_id"]
            isOneToOne: false
            referencedRelation: "competition_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_side_b_competition_fk"
            columns: ["side_b_entity_id", "competition_id"]
            isOneToOne: false
            referencedRelation: "competition_entities"
            referencedColumns: ["id", "competition_id"]
          },
          {
            foreignKeyName: "matches_side_b_entity_id_fkey"
            columns: ["side_b_entity_id"]
            isOneToOne: false
            referencedRelation: "competition_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_winner_competition_fk"
            columns: ["winner_entity_id", "competition_id"]
            isOneToOne: false
            referencedRelation: "competition_entities"
            referencedColumns: ["id", "competition_id"]
          },
          {
            foreignKeyName: "matches_winner_entity_id_fkey"
            columns: ["winner_entity_id"]
            isOneToOne: false
            referencedRelation: "competition_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      participant_handicaps: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          participant_id: string
          source: Database["public"]["Enums"]["handicap_source"]
          source_reference: string | null
          updated_at: string
          value: number
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          id?: string
          participant_id: string
          source: Database["public"]["Enums"]["handicap_source"]
          source_reference?: string | null
          updated_at?: string
          value: number
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          participant_id?: string
          source?: Database["public"]["Enums"]["handicap_source"]
          source_reference?: string | null
          updated_at?: string
          value?: number
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "participant_handicaps_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "participant_handicaps_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      participants: {
        Row: {
          created_at: string
          display_name: string
          external_ref: string | null
          id: string
          league_id: string
          organizer_notes: string | null
          profile_id: string | null
          sort_name: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name: string
          external_ref?: string | null
          id?: string
          league_id: string
          organizer_notes?: string | null
          profile_id?: string | null
          sort_name: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          external_ref?: string | null
          id?: string
          league_id?: string
          organizer_notes?: string | null
          profile_id?: string | null
          sort_name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "participants_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "participants_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string
          id: string
          must_change_password: boolean
          privacy_accepted_at: string | null
          status: Database["public"]["Enums"]["account_status"]
          updated_at: string
          username: string
        }
        Insert: {
          created_at?: string
          display_name: string
          id: string
          must_change_password?: boolean
          privacy_accepted_at?: string | null
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
          username: string
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          must_change_password?: boolean
          privacy_accepted_at?: string | null
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth_key: string
          created_at: string
          device_label: string | null
          endpoint: string
          id: string
          last_failure_at: string | null
          last_success_at: string | null
          p256dh_key: string
          permission_status: string
          profile_id: string
          revoked_at: string | null
          updated_at: string
        }
        Insert: {
          auth_key: string
          created_at?: string
          device_label?: string | null
          endpoint: string
          id?: string
          last_failure_at?: string | null
          last_success_at?: string | null
          p256dh_key: string
          permission_status?: string
          profile_id: string
          revoked_at?: string | null
          updated_at?: string
        }
        Update: {
          auth_key?: string
          created_at?: string
          device_label?: string | null
          endpoint?: string
          id?: string
          last_failure_at?: string | null
          last_success_at?: string | null
          p256dh_key?: string
          permission_status?: string
          profile_id?: string
          revoked_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      role_assignments: {
        Row: {
          event_id: string | null
          granted_at: string
          granted_by: string | null
          id: string
          league_id: string
          profile_id: string
          revoked_at: string | null
          role: Database["public"]["Enums"]["app_role"]
        }
        Insert: {
          event_id?: string | null
          granted_at?: string
          granted_by?: string | null
          id?: string
          league_id: string
          profile_id: string
          revoked_at?: string | null
          role: Database["public"]["Enums"]["app_role"]
        }
        Update: {
          event_id?: string | null
          granted_at?: string
          granted_by?: string | null
          id?: string
          league_id?: string
          profile_id?: string
          revoked_at?: string | null
          role?: Database["public"]["Enums"]["app_role"]
        }
        Relationships: [
          {
            foreignKeyName: "role_assignments_event_fk"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_assignments_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_assignments_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_assignments_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rounds: {
        Row: {
          created_at: string
          event_id: string
          hole_count: number
          id: string
          name: string | null
          round_number: number
          snapshot_version: number | null
          source_tee_set_id: string | null
          starts_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          event_id: string
          hole_count: number
          id?: string
          name?: string | null
          round_number: number
          snapshot_version?: number | null
          source_tee_set_id?: string | null
          starts_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          event_id?: string
          hole_count?: number
          id?: string
          name?: string | null
          round_number?: number
          snapshot_version?: number | null
          source_tee_set_id?: string | null
          starts_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rounds_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rounds_source_tee_set_id_fkey"
            columns: ["source_tee_set_id"]
            isOneToOne: false
            referencedRelation: "tee_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      score_conflicts: {
        Row: {
          base_revision: number | null
          created_at: string
          event_entry_id: string | null
          event_hole_id: string
          event_id: string
          event_team_id: string | null
          id: string
          local_actor_profile_id: string | null
          local_payload: Json
          resolution_choice: string | null
          resolution_reason: string | null
          resolution_value: Json | null
          resolved_at: string | null
          resolved_by: string | null
          round_id: string
          server_actor_profile_id: string | null
          server_payload: Json
          server_revision: number | null
          status: Database["public"]["Enums"]["conflict_status"]
          target_kind: string
          updated_at: string
        }
        Insert: {
          base_revision?: number | null
          created_at?: string
          event_entry_id?: string | null
          event_hole_id: string
          event_id: string
          event_team_id?: string | null
          id?: string
          local_actor_profile_id?: string | null
          local_payload: Json
          resolution_choice?: string | null
          resolution_reason?: string | null
          resolution_value?: Json | null
          resolved_at?: string | null
          resolved_by?: string | null
          round_id: string
          server_actor_profile_id?: string | null
          server_payload: Json
          server_revision?: number | null
          status?: Database["public"]["Enums"]["conflict_status"]
          target_kind: string
          updated_at?: string
        }
        Update: {
          base_revision?: number | null
          created_at?: string
          event_entry_id?: string | null
          event_hole_id?: string
          event_id?: string
          event_team_id?: string | null
          id?: string
          local_actor_profile_id?: string | null
          local_payload?: Json
          resolution_choice?: string | null
          resolution_reason?: string | null
          resolution_value?: Json | null
          resolved_at?: string | null
          resolved_by?: string | null
          round_id?: string
          server_actor_profile_id?: string | null
          server_payload?: Json
          server_revision?: number | null
          status?: Database["public"]["Enums"]["conflict_status"]
          target_kind?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "score_conflicts_event_entry_id_fkey"
            columns: ["event_entry_id"]
            isOneToOne: false
            referencedRelation: "event_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_conflicts_event_hole_id_fkey"
            columns: ["event_hole_id"]
            isOneToOne: false
            referencedRelation: "event_holes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_conflicts_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_conflicts_event_team_id_fkey"
            columns: ["event_team_id"]
            isOneToOne: false
            referencedRelation: "event_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_conflicts_local_actor_profile_id_fkey"
            columns: ["local_actor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_conflicts_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_conflicts_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_conflicts_server_actor_profile_id_fkey"
            columns: ["server_actor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      score_mutations: {
        Row: {
          actor_profile_id: string
          base_revision: number
          client_recorded_at: string | null
          created_at: string
          device_id_hash: string | null
          event_entry_id: string | null
          event_hole_id: string
          event_id: string
          event_revision: number | null
          event_team_id: string | null
          idempotency_key: string
          new_value: Json
          prior_value: Json | null
          reason: string | null
          result: Database["public"]["Enums"]["mutation_result"]
          round_id: string
          target_kind: string
        }
        Insert: {
          actor_profile_id: string
          base_revision: number
          client_recorded_at?: string | null
          created_at?: string
          device_id_hash?: string | null
          event_entry_id?: string | null
          event_hole_id: string
          event_id: string
          event_revision?: number | null
          event_team_id?: string | null
          idempotency_key: string
          new_value: Json
          prior_value?: Json | null
          reason?: string | null
          result: Database["public"]["Enums"]["mutation_result"]
          round_id: string
          target_kind: string
        }
        Update: {
          actor_profile_id?: string
          base_revision?: number
          client_recorded_at?: string | null
          created_at?: string
          device_id_hash?: string | null
          event_entry_id?: string | null
          event_hole_id?: string
          event_id?: string
          event_revision?: number | null
          event_team_id?: string | null
          idempotency_key?: string
          new_value?: Json
          prior_value?: Json | null
          reason?: string | null
          result?: Database["public"]["Enums"]["mutation_result"]
          round_id?: string
          target_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "score_mutations_actor_profile_id_fkey"
            columns: ["actor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_mutations_event_entry_id_fkey"
            columns: ["event_entry_id"]
            isOneToOne: false
            referencedRelation: "event_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_mutations_event_hole_id_fkey"
            columns: ["event_hole_id"]
            isOneToOne: false
            referencedRelation: "event_holes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_mutations_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_mutations_event_team_id_fkey"
            columns: ["event_team_id"]
            isOneToOne: false
            referencedRelation: "event_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_mutations_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      scorecard_attestations: {
        Row: {
          attestation_type: Database["public"]["Enums"]["attestation_type"]
          attested_at: string
          created_at: string
          event_entry_id: string | null
          event_team_id: string | null
          id: string
          profile_id: string
          reason: string | null
          round_id: string
          score_revision: number
        }
        Insert: {
          attestation_type: Database["public"]["Enums"]["attestation_type"]
          attested_at?: string
          created_at?: string
          event_entry_id?: string | null
          event_team_id?: string | null
          id?: string
          profile_id: string
          reason?: string | null
          round_id: string
          score_revision: number
        }
        Update: {
          attestation_type?: Database["public"]["Enums"]["attestation_type"]
          attested_at?: string
          created_at?: string
          event_entry_id?: string | null
          event_team_id?: string | null
          id?: string
          profile_id?: string
          reason?: string | null
          round_id?: string
          score_revision?: number
        }
        Relationships: [
          {
            foreignKeyName: "scorecard_attestations_event_entry_id_fkey"
            columns: ["event_entry_id"]
            isOneToOne: false
            referencedRelation: "event_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scorecard_attestations_event_team_id_fkey"
            columns: ["event_team_id"]
            isOneToOne: false
            referencedRelation: "event_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scorecard_attestations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scorecard_attestations_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      scoring_permissions: {
        Row: {
          created_at: string
          event_id: string
          grant_origin: string
          id: string
          participant_id: string | null
          permission_type: string
          round_id: string
          scorer_profile_id: string
          team_id: string | null
          updated_at: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          created_at?: string
          event_id: string
          grant_origin?: string
          id?: string
          participant_id?: string | null
          permission_type: string
          round_id: string
          scorer_profile_id: string
          team_id?: string | null
          updated_at?: string
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          created_at?: string
          event_id?: string
          grant_origin?: string
          id?: string
          participant_id?: string | null
          permission_type?: string
          round_id?: string
          scorer_profile_id?: string
          team_id?: string | null
          updated_at?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scoring_permissions_event_fk"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scoring_permissions_participant_fk"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scoring_permissions_round_same_event_fk"
            columns: ["round_id", "event_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id", "event_id"]
          },
          {
            foreignKeyName: "scoring_permissions_scorer_profile_id_fkey"
            columns: ["scorer_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scoring_permissions_team_fk"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      seasons: {
        Row: {
          created_at: string
          ends_on: string
          id: string
          league_id: string
          name: string
          starts_on: string
          status: Database["public"]["Enums"]["season_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          ends_on: string
          id?: string
          league_id: string
          name: string
          starts_on: string
          status?: Database["public"]["Enums"]["season_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          ends_on?: string
          id?: string
          league_id?: string
          name?: string
          starts_on?: string
          status?: Database["public"]["Enums"]["season_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "seasons_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
        ]
      }
      team_hole_scores: {
        Row: {
          client_recorded_at: string | null
          created_at: string
          device_id_hash: string | null
          entered_by: string | null
          event_hole_id: string
          event_id: string
          event_team_id: string
          gross_strokes: number | null
          id: string
          notes: string | null
          revision: number
          round_id: string
          score_status: Database["public"]["Enums"]["score_status"]
          server_recorded_at: string
          source: string
          submitted_at: string | null
          updated_at: string
        }
        Insert: {
          client_recorded_at?: string | null
          created_at?: string
          device_id_hash?: string | null
          entered_by?: string | null
          event_hole_id: string
          event_id: string
          event_team_id: string
          gross_strokes?: number | null
          id?: string
          notes?: string | null
          revision?: number
          round_id: string
          score_status?: Database["public"]["Enums"]["score_status"]
          server_recorded_at?: string
          source?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Update: {
          client_recorded_at?: string | null
          created_at?: string
          device_id_hash?: string | null
          entered_by?: string | null
          event_hole_id?: string
          event_id?: string
          event_team_id?: string
          gross_strokes?: number | null
          id?: string
          notes?: string | null
          revision?: number
          round_id?: string
          score_status?: Database["public"]["Enums"]["score_status"]
          server_recorded_at?: string
          source?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_hole_scores_entered_by_fkey"
            columns: ["entered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_hole_scores_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_hole_scores_hole_fk"
            columns: ["event_hole_id", "round_id"]
            isOneToOne: false
            referencedRelation: "event_holes"
            referencedColumns: ["id", "round_id"]
          },
          {
            foreignKeyName: "team_hole_scores_round_fk"
            columns: ["round_id", "event_id"]
            isOneToOne: false
            referencedRelation: "rounds"
            referencedColumns: ["id", "event_id"]
          },
          {
            foreignKeyName: "team_hole_scores_team_fk"
            columns: ["event_team_id", "event_id"]
            isOneToOne: false
            referencedRelation: "event_teams"
            referencedColumns: ["id", "event_id"]
          },
        ]
      }
      team_members: {
        Row: {
          created_at: string
          id: string
          participant_id: string
          team_id: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          participant_id: string
          team_id: string
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          participant_id?: string
          team_id?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "team_members_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_members_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          created_at: string
          id: string
          league_id: string
          name: string
          season_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          league_id: string
          name: string
          season_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          league_id?: string
          name?: string
          season_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      tee_holes: {
        Row: {
          course_hole_label: string | null
          created_at: string
          hole_ordinal: number
          par: number
          stroke_index: number
          tee_set_id: string
          updated_at: string
          yardage: number | null
        }
        Insert: {
          course_hole_label?: string | null
          created_at?: string
          hole_ordinal: number
          par: number
          stroke_index: number
          tee_set_id: string
          updated_at?: string
          yardage?: number | null
        }
        Update: {
          course_hole_label?: string | null
          created_at?: string
          hole_ordinal?: number
          par?: number
          stroke_index?: number
          tee_set_id?: string
          updated_at?: string
          yardage?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tee_holes_tee_set_id_fkey"
            columns: ["tee_set_id"]
            isOneToOne: false
            referencedRelation: "tee_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      tee_sets: {
        Row: {
          course_layout_id: string
          course_rating: number
          created_at: string
          id: string
          name: string
          par: number
          rating_category: string | null
          slope_rating: number
          status: string
          updated_at: string
          version: number
        }
        Insert: {
          course_layout_id: string
          course_rating: number
          created_at?: string
          id?: string
          name: string
          par: number
          rating_category?: string | null
          slope_rating: number
          status?: string
          updated_at?: string
          version?: number
        }
        Update: {
          course_layout_id?: string
          course_rating?: number
          created_at?: string
          id?: string
          name?: string
          par?: number
          rating_category?: string | null
          slope_rating?: number
          status?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "tee_sets_course_layout_id_fkey"
            columns: ["course_layout_id"]
            isOneToOne: false
            referencedRelation: "course_layouts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_score_mutation: {
        Args: {
          p_base_revision: number
          p_client_recorded_at: string
          p_device_id_hash: string
          p_entry_id: string
          p_event_id: string
          p_gross_strokes: number
          p_hole_id: string
          p_idempotency_key: string
          p_notes: string
          p_round_id: string
          p_status: Database["public"]["Enums"]["score_status"]
          p_target_kind: string
          p_team_id: string
        }
        Returns: Json
      }
      apply_score_mutation_without_finalization_guard: {
        Args: {
          p_base_revision: number
          p_client_recorded_at: string
          p_device_id_hash: string
          p_entry_id: string
          p_event_id: string
          p_gross_strokes: number
          p_hole_id: string
          p_idempotency_key: string
          p_notes: string
          p_round_id: string
          p_status: Database["public"]["Enums"]["score_status"]
          p_target_kind: string
          p_team_id: string
        }
        Returns: Json
      }
      attest_phase2_scorecard: {
        Args: {
          p_actor: string
          p_attestation_type: Database["public"]["Enums"]["attestation_type"]
          p_reason?: string
          p_round_id: string
          p_target_id: string
          p_target_kind: string
        }
        Returns: Json
      }
      bootstrap_initial_owner: {
        Args: {
          p_display_name: string
          p_existing_league_id: string
          p_league_name: string
          p_league_slug: string
          p_locale: string
          p_profile_id: string
          p_timezone: string
          p_username: string
        }
        Returns: Json
      }
      claim_projection_publish: {
        Args: { p_event_id: string; p_lease_token: string; p_revision: number }
        Returns: string
      }
      consume_rate_limit: {
        Args: { p_bucket: string; p_max: number; p_window: string }
        Returns: boolean
      }
      event_projections_current: {
        Args: { p_event_id: string }
        Returns: boolean
      }
      export_portable_snapshot: {
        Args: { p_actor: string; p_event_id: string; p_league_id: string }
        Returns: Json
      }
      finalize_phase1_competition: {
        Args: {
          p_actor: string
          p_competition_id: string
          p_override_reason?: string
        }
        Returns: Json
      }
      mark_score_conflict_resolved: {
        Args: {
          p_actor: string
          p_choice: string
          p_conflict_id: string
          p_reason: string
          p_value: Json
        }
        Returns: Json
      }
      participant_organizer_notes: {
        Args: { p_participant_id: string }
        Returns: string
      }
      phase4_operations_snapshot: { Args: never; Returns: Json }
      prune_phase4_error_events: { Args: { p_before?: string }; Returns: Json }
      publish_phase1_event: {
        Args: { p_actor: string; p_event_id: string; p_open_scoring?: boolean }
        Returns: Json
      }
      publish_phase2_event: {
        Args: { p_actor: string; p_event_id: string; p_open_scoring?: boolean }
        Returns: Json
      }
      publish_phase3_scramble_event: {
        Args: { p_actor: string; p_event_id: string; p_open_scoring?: boolean }
        Returns: Json
      }
      publish_projections: {
        Args: { p_event_id: string; p_result: Json; p_revision: number }
        Returns: Json
      }
      record_phase4_error: {
        Args: {
          p_correlation_id: string
          p_error_code: string
          p_release: string
          p_route_family: string
          p_severity: string
        }
        Returns: Json
      }
      release_projection_publish: {
        Args: { p_event_id: string; p_lease_token: string; p_revision: number }
        Returns: boolean
      }
      renew_projection_publish_lease: {
        Args: { p_event_id: string; p_lease_token: string }
        Returns: boolean
      }
      reopen_competition: {
        Args: { p_actor: string; p_competition_id: string; p_reason: string }
        Returns: Json
      }
      resolve_score_conflict_atomic: {
        Args: {
          p_actor: string
          p_choice: string
          p_conflict_id: string
          p_manual_value: Json
          p_reason: string
        }
        Returns: Json
      }
      restore_portable_export: { Args: { p_tables: Json }; Returns: Json }
      restore_portable_individual_scores: {
        Args: { p_rows: Json }
        Returns: number
      }
      restore_portable_matches: { Args: { p_rows: Json }; Returns: number }
      restore_portable_projection_artifact: {
        Args: {
          p_hole_results: Json
          p_leaderboard_rows: Json
          p_projections: Json
        }
        Returns: Json
      }
      restore_portable_team_scores: { Args: { p_rows: Json }; Returns: number }
      save_phase1_event_draft: {
        Args: {
          p_actor: string
          p_ends_at: string
          p_event_id: string
          p_league_id: string
          p_name: string
          p_participant_ids: string[]
          p_scorer_profile_ids?: string[]
          p_season_id: string
          p_starts_at: string
          p_tee_set_id: string
          p_timezone: string
          p_visibility: Database["public"]["Enums"]["event_visibility"]
        }
        Returns: Json
      }
      save_phase2_event_draft: {
        Args: {
          p_actor: string
          p_competition_preset?: string
          p_ends_at: string
          p_event_id: string
          p_league_id: string
          p_name: string
          p_participant_ids: string[]
          p_scorer_profile_ids?: string[]
          p_season_id: string
          p_starts_at: string
          p_teams?: Json
          p_tee_set_id: string
          p_timezone: string
          p_visibility: Database["public"]["Enums"]["event_visibility"]
        }
        Returns: Json
      }
      save_phase3_scramble_event_draft: {
        Args: {
          p_actor: string
          p_competition_preset?: string
          p_ends_at: string
          p_event_id: string
          p_league_id: string
          p_name: string
          p_participant_ids: string[]
          p_scorer_profile_ids?: string[]
          p_season_id: string
          p_starts_at: string
          p_teams?: Json
          p_tee_set_id: string
          p_timezone: string
          p_visibility: Database["public"]["Enums"]["event_visibility"]
        }
        Returns: Json
      }
      set_event_flights: {
        Args: { p_event_id: string; p_flights: Json }
        Returns: Json
      }
      set_match_result: {
        Args: {
          p_actor: string
          p_correlation_id: string
          p_match_id: string
          p_reason: string
          p_result_summary: string
          p_status: string
          p_winner_entity_id: string
        }
        Returns: Json
      }
      substitute_event_entry: {
        Args: {
          p_effective_round_id: string
          p_event_id: string
          p_incoming_participant_id: string
          p_outgoing_entry_id: string
          p_reason: string
        }
        Returns: Json
      }
    }
    Enums: {
      account_status: "active" | "disabled"
      app_role:
        | "owner"
        | "league_admin"
        | "event_director"
        | "marker"
        | "player"
        | "spectator"
      attestation_type: "player" | "marker" | "director_override"
      conflict_status: "open" | "resolved"
      entity_status: "active" | "withdrawn" | "no_return" | "disqualified"
      event_status:
        | "draft"
        | "published"
        | "scoring_open"
        | "scoring_closed"
        | "finalized"
        | "archived"
      event_visibility: "league" | "public" | "organizers"
      handicap_source:
        | "manual_verified"
        | "authorized_import"
        | "league_value"
        | "scratch_fallback"
        | "none"
      member_status: "active" | "inactive" | "removed"
      mutation_result:
        | "committed"
        | "duplicate"
        | "conflict"
        | "rejected"
        | "queued_projection"
      score_status:
        | "not_started"
        | "complete"
        | "picked_up"
        | "conceded"
        | "not_played"
        | "no_score"
        | "withdrawn"
        | "disqualified"
      season_status: "planned" | "active" | "completed" | "archived"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_status: ["active", "disabled"],
      app_role: [
        "owner",
        "league_admin",
        "event_director",
        "marker",
        "player",
        "spectator",
      ],
      attestation_type: ["player", "marker", "director_override"],
      conflict_status: ["open", "resolved"],
      entity_status: ["active", "withdrawn", "no_return", "disqualified"],
      event_status: [
        "draft",
        "published",
        "scoring_open",
        "scoring_closed",
        "finalized",
        "archived",
      ],
      event_visibility: ["league", "public", "organizers"],
      handicap_source: [
        "manual_verified",
        "authorized_import",
        "league_value",
        "scratch_fallback",
        "none",
      ],
      member_status: ["active", "inactive", "removed"],
      mutation_result: [
        "committed",
        "duplicate",
        "conflict",
        "rejected",
        "queued_projection",
      ],
      score_status: [
        "not_started",
        "complete",
        "picked_up",
        "conceded",
        "not_played",
        "no_score",
        "withdrawn",
        "disqualified",
      ],
      season_status: ["planned", "active", "completed", "archived"],
    },
  },
} as const
