import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';

import { saveCatalogItem } from '../lib/phase1.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

const HOLE_TEMPLATE = [
  '1,4,400,1', '2,4,390,2', '3,3,165,3', '4,5,525,4', '5,4,375,5', '6,4,410,6',
  '7,3,155,7', '8,4,385,8', '9,5,510,9', '10,4,395,10', '11,5,535,11', '12,3,175,12',
  '13,4,370,13', '14,4,420,14', '15,4,360,15', '16,3,145,16', '17,5,500,17', '18,4,390,18',
].join('\n');

export function LeagueCourses() {
  const { leagueId = '' } = useParams();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ['courses', leagueId], queryFn: async () => { const { data, error } = await getSupabaseClient().from('courses').select('id,name,location_text,timezone,course_layouts(id,name,hole_count,tee_sets(id,name,par,course_rating,slope_rating,status))').eq('league_id', leagueId).order('name'); if (error) throw error; return data ?? []; } });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setStatus(null); const form = new FormData(event.currentTarget);
    try {
      const holes = String(form.get('holes')).trim().split(/\n+/).map((line) => { const [ordinal, par, yardage, strokeIndex] = line.split(',').map((value) => Number(value.trim())); return { ordinal, par, yardage: Number.isFinite(yardage) ? yardage : null, strokeIndex }; });
      await saveCatalogItem({ action: 'create-course', leagueId, name: form.get('name'), location: form.get('location'), timezone: form.get('timezone'), layoutName: form.get('layoutName'), teeName: form.get('teeName'), ratingCategory: 'standard', courseRating: Number(form.get('courseRating')), slopeRating: Number(form.get('slopeRating')), holes });
      setStatus('Course and tee set added.'); await query.refetch();
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : 'Could not add course.'); }
    finally { setBusy(false); }
  }
  return <div className="screen catalog-screen"><header className="page-header"><Link className="back-link" to={`/league/${leagueId}`}>Back to league</Link><h1>Courses and tees</h1><p>Rating and hole data used to create immutable event snapshots.</p></header>{status && <p className="form-message" role="status">{status}</p>}<div className="catalog-layout catalog-layout--courses"><section><div className="section-heading"><h2>Course catalog</h2><span>{query.data?.length ?? 0}</span></div><div className="course-list">{query.data?.map((course) => <article key={course.id}><div><h3>{course.name}</h3><p>{course.location_text ?? course.timezone}</p></div>{course.course_layouts.map((layout) => <div className="tee-list" key={layout.id}><strong>{layout.name} · {layout.hole_count} holes</strong>{layout.tee_sets.map((tee) => <span key={tee.id}>{tee.name} — Par {tee.par} · Rating {tee.course_rating} · Slope {tee.slope_rating}</span>)}</div>)}</article>)}</div></section><section className="catalog-form catalog-form--wide"><h2>Add course and tee</h2><form className="form-grid" onSubmit={(event) => void submit(event)}><div className="field"><label htmlFor="course-name">Course name</label><input id="course-name" name="name" required /></div><div className="field"><label htmlFor="course-location">Location</label><input id="course-location" name="location" /></div><div className="field"><label htmlFor="course-timezone">Timezone</label><input id="course-timezone" name="timezone" defaultValue="America/Detroit" required /></div><div className="field"><label htmlFor="layout-name">Layout name</label><input id="layout-name" name="layoutName" defaultValue="Championship 18" required /></div><div className="field"><label htmlFor="tee-name">Tee name</label><input id="tee-name" name="teeName" defaultValue="White" required /></div><div className="field"><label htmlFor="course-rating">Course rating</label><input id="course-rating" name="courseRating" type="number" min="50" max="90" step="0.1" defaultValue="72.0" required /></div><div className="field"><label htmlFor="slope-rating">Slope rating</label><input id="slope-rating" name="slopeRating" type="number" min="55" max="155" defaultValue="113" required /></div><div className="field field--wide"><label htmlFor="holes">Holes: ordinal, par, yards, stroke index</label><textarea id="holes" name="holes" rows={18} defaultValue={HOLE_TEMPLATE} spellCheck={false} required /><small>Use 9 or 18 lines. Ordinals and stroke indexes must each be unique and complete.</small></div><button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add course'}</button></form></section></div></div>;
}
