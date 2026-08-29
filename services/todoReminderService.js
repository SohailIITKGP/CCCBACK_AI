const WorkTodo = require("../models/WorkTodo");
const { recordTodoActivity } = require("./todoActivityService");
const { createNotificationForUser } = require("../utils/notification");
const { uniqueIds } = require("../utils/todoAccess");
const { startOfDay } = require("../utils/todoTiming");

async function dispatchDueReminders(now = new Date()) {
  const due = await WorkTodo.find({
    status: { $in: ["To Do", "In Progress"] },
    reminders: {
      $elemMatch: {
        sentAt: null,
        remindAt: { $ne: null, $lte: now },
      },
    },
  }).select("title assignedTo owner collaborators reminders");

  let sent = 0;
  for (const todo of due) {
    let changed = false;
    for (const reminder of todo.reminders) {
      if (reminder.sentAt || !reminder.remindAt || reminder.remindAt > now) continue;
      reminder.sentAt = now;
      changed = true;
      sent += 1;

      const recipients = uniqueIds([
        ...(todo.assignedTo || []),
        todo.owner,
        ...(todo.collaborators || []),
      ]);
      await Promise.all(
        recipients.map((uid) =>
          createNotificationForUser({
            recipientUserId: uid,
            type: "Todo",
            action: "Reminder",
            entityId: todo._id,
            entityName: todo.title,
            message: `Reminder: "${todo.title}"${reminder.label ? ` — ${reminder.label}` : ""}`,
            category: "todo_reminder",
            severity: "warning",
            meta: { path: `/todos?id=${todo._id}` },
          })
        )
      );
      await recordTodoActivity({
        eventType: "reminder_sent",
        todoId: todo._id,
        newValue: { label: reminder.label, remindAt: reminder.remindAt },
      });
    }
    if (changed) await todo.save();
  }
  return { sent };
}

async function dispatchOverdueNotifications(now = new Date()) {
  const todayStart = startOfDay(now);
  const overdue = await WorkTodo.find({
    status: { $in: ["To Do", "In Progress"] },
    dueAt: { $ne: null, $lt: todayStart },
    overdueNotifiedAt: null,
  }).select("title assignedTo owner assignedBy team dueAt");

  let notified = 0;
  for (const todo of overdue) {
    const recipients = uniqueIds([
      ...(todo.assignedTo || []),
      todo.owner,
      todo.assignedBy,
    ]);
    await Promise.all(
      recipients.map((uid) =>
        createNotificationForUser({
          recipientUserId: uid,
          type: "Todo",
          action: "Overdue",
          entityId: todo._id,
          entityName: todo.title,
          message: `"${todo.title}" is overdue`,
          category: "todo_overdue",
          severity: "critical",
          meta: { path: `/todos?id=${todo._id}` },
        })
      )
    );

    todo.overdueNotifiedAt = now;
    await todo.save();
    notified += 1;
  }
  return { notified };
}

async function runTodoReminderSweep() {
  const now = new Date();
  const reminders = await dispatchDueReminders(now);
  const overdue = await dispatchOverdueNotifications(now);
  const { generateUpcomingOccurrences } = require("./todoRecurrenceService");
  const recurring = await WorkTodo.find({
    "recurrence.enabled": true,
    parentTodoId: null,
    status: { $ne: "Cancelled" },
  }).limit(200);
  let occurrences = 0;
  for (const parent of recurring) {
    const result = await generateUpcomingOccurrences(parent, { lookaheadDays: 21 });
    occurrences += result.created || 0;
  }
  return { reminders: reminders.sent, overdue: overdue.notified, occurrences };
}

module.exports = {
  dispatchDueReminders,
  dispatchOverdueNotifications,
  runTodoReminderSweep,
};
