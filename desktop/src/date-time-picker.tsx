import {useId, useLayoutEffect, useRef, useState} from 'react';
import type {KeyboardEvent, RefObject} from 'react';
import {createPortal} from 'react-dom';
import {CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock3} from 'lucide-react';
import {calendarDate, calendarDays, localDateTime, moveCalendarDate, moveCalendarMonth, parseCalendarDate, twoDigits} from './date-time';
import './date-time-picker.css';

type DateTimeValue = {date: string; time: string};
type Props = {
  label: string;
  value: DateTimeValue;
  disabled?: boolean;
  onChange: (value: DateTimeValue) => void;
};

export function DateTimePicker({label, value, disabled, onChange}: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({preventScroll: true});
  }
  return <div className="date-time-field">
    <span id={`${id}-label`} className="date-time-label">{label}</span>
    <button ref={trigger} type="button" className="date-time-trigger" disabled={disabled}
      aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => setOpen(current => !current)}>
      <CalendarDays aria-hidden="true"/>
      <span id={`${id}-value`} className={value.date ? '' : 'date-time-placeholder'}>
        {value.date ? <>{value.date.replaceAll('-', '/')}<span className="date-time-value-time">{value.time}</span></> : '选择日期和时间'}
      </span>
      <ChevronDown aria-hidden="true"/>
    </button>
    {open && !disabled && <DateTimePopover id={id} label={label} value={value} trigger={trigger}
      onClose={close} onChange={next => {onChange(next); close(true);}}/>}
  </div>;
}

function DateTimePopover({id, label, value, trigger, onClose, onChange}: Props & {
  id: string;
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const today = calendarDate(new Date());
  const [date, setDate] = useState(value.date || today);
  const [focusDay, setFocusDay] = useState(date);
  const [month, setMonth] = useState(date.slice(0, 7));
  const [hours, setHours] = useState(value.time.split(':')[0] || '00');
  const [minutes, setMinutes] = useState(value.time.split(':')[1] || '00');
  const card = useRef<HTMLElement>(null);
  const shouldFocusDay = useRef(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const timeValid = /^\d{1,2}$/.test(hours) && Number(hours) < 24 && /^\d{1,2}$/.test(minutes) && Number(minutes) < 60;
  const time = `${twoDigits(Number(hours))}:${twoDigits(Number(minutes))}`;
  const valid = timeValid && !!localDateTime(date, time);

  useLayoutEffect(() => {
    const popup = card.current!, anchor = trigger.current!;
    function fit() {
      const rect = anchor.getBoundingClientRect();
      const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
      const margin = 12, gap = 8, popupHeight = popup.offsetHeight;
      const below = height - rect.bottom - gap - margin;
      const top = popupHeight <= below ? rect.bottom + gap : rect.top - gap - popupHeight;
      popup.style.left = `${Math.max(margin, Math.min(rect.left, width - popup.offsetWidth - margin))}px`;
      popup.style.top = `${Math.max(margin, Math.min(top, height - popupHeight - margin))}px`;
      popup.style.visibility = 'visible';
    }
    function outside(event: Event) {
      if (event.target instanceof Node && !popup.contains(event.target) && !anchor.contains(event.target)) closeRef.current();
    }
    const observer = new ResizeObserver(fit);
    observer.observe(popup);
    observer.observe(anchor);
    fit();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', fit);
    window.addEventListener('scroll', fit, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', fit);
      window.removeEventListener('scroll', fit, true);
    };
  }, [trigger]);

  useLayoutEffect(() => {
    if (!shouldFocusDay.current) return;
    card.current?.querySelector<HTMLButtonElement>(`[data-date="${focusDay}"]`)?.focus({preventScroll: true});
    shouldFocusDay.current = false;
  }, [focusDay, month]);

  function showMonth(delta: number) {
    const next = moveCalendarMonth(focusDay, delta);
    setFocusDay(next);
    setMonth(next.slice(0, 7));
  }
  function navigateDay(event: KeyboardEvent<HTMLButtonElement>, day: string) {
    const weekdays = (parseCalendarDate(day)!.getDay() + 6) % 7;
    let next: string;
    switch (event.key) {
      case 'ArrowLeft': next = moveCalendarDate(day, -1); break;
      case 'ArrowRight': next = moveCalendarDate(day, 1); break;
      case 'ArrowUp': next = moveCalendarDate(day, -7); break;
      case 'ArrowDown': next = moveCalendarDate(day, 7); break;
      case 'Home': next = moveCalendarDate(day, -weekdays); break;
      case 'End': next = moveCalendarDate(day, 6 - weekdays); break;
      case 'PageUp': next = moveCalendarMonth(day, event.shiftKey ? -12 : -1); break;
      case 'PageDown': next = moveCalendarMonth(day, event.shiftKey ? 12 : 1); break;
      default: return;
    }
    event.preventDefault();
    shouldFocusDay.current = true;
    setFocusDay(next);
    setMonth(next.slice(0, 7));
  }
  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    }
    if (event.key === 'Tab') {
      event.stopPropagation();
      const items = [...card.current!.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled)')];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
      if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first.focus();}
    }
  }
  return createPortal(<section ref={card} id={id} className="date-time-popover" role="dialog" aria-modal="true"
    aria-label={`选择${label}`} onKeyDown={handleKeys}>
    <div className="date-time-popover-header">
      <span>{label}</span>
      <button type="button" className="date-time-today" onClick={() => {setDate(today); setFocusDay(today); setMonth(today.slice(0, 7));}}>今天</button>
    </div>
    <div className="date-time-month-nav">
      <button type="button" aria-label="上个月" onClick={() => showMonth(-1)}><ChevronLeft/></button>
      <strong aria-live="polite">{Number(month.slice(0, 4))} 年 {Number(month.slice(5))} 月</strong>
      <button type="button" aria-label="下个月" onClick={() => showMonth(1)}><ChevronRight/></button>
    </div>
    <div className="date-time-weekdays" aria-hidden="true">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
    <div className="date-time-days" role="group" aria-label="日期">
      {calendarDays(month).map(day => <button type="button" key={day} data-date={day} tabIndex={focusDay === day ? 0 : -1}
        className={`${day.slice(0, 7) !== month ? 'outside-month' : ''} ${day === today ? 'today' : ''}`}
        aria-label={`${day.replace('-', '年').replace('-', '月')}日`} aria-pressed={day === date} aria-current={day === today ? 'date' : undefined}
        onKeyDown={event => navigateDay(event, day)} onClick={() => {setDate(day); setFocusDay(day); setMonth(day.slice(0, 7));}}>{Number(day.slice(-2))}</button>)}
    </div>
    <div className="date-time-clock">
      <span><Clock3 aria-hidden="true"/>时间</span>
      <div className="date-time-steppers">
        <TimePart label="小时" value={hours} maximum={23} onChange={setHours}/>
        <span aria-hidden="true">:</span>
        <TimePart label="分钟" value={minutes} maximum={59} onChange={setMinutes}/>
      </div>
    </div>
    {!valid && <p className="date-time-error" role="alert">请选择有效的时间（00:00–23:59）。</p>}
    <div className="date-time-popover-actions">
      <button type="button" onClick={() => onClose(true)}>取消</button>
      <button type="button" className="primary" disabled={!valid} onClick={() => onChange({date, time})}>确定</button>
    </div>
  </section>, document.body);
}

function TimePart({label, value, maximum, onChange}: {label: string; value: string; maximum: number; onChange: (value: string) => void}) {
  function step(amount: number) {onChange(twoDigits((Number(value) + amount + maximum + 1) % (maximum + 1)));}
  return <div className="date-time-stepper">
    <input aria-label={label} role="spinbutton" aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={value ? Number(value) : undefined}
      type="text" inputMode="numeric" maxLength={2} value={value} onFocus={event => event.target.select()}
      onChange={event => {if (/^\d{0,2}$/.test(event.target.value)) onChange(event.target.value);}}
      onBlur={() => {if (value && Number(value) <= maximum) onChange(twoDigits(Number(value)));}}
      onKeyDown={event => {if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {event.preventDefault(); step(event.key === 'ArrowUp' ? 1 : -1);}}}/>
    <div><button type="button" aria-label={`增加${label}`} onClick={() => step(1)}><ChevronUp/></button>
      <button type="button" aria-label={`减少${label}`} onClick={() => step(-1)}><ChevronDown/></button></div>
  </div>;
}
