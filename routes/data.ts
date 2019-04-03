import * as common from "../common";
import * as express from "express";
import * as moment from "moment";

export let dataRouter = express.Router();

const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";

let authenticateCheck = common.authenticateMiddleware;

export interface ScheduleItem {
	title: string;
	slug: string | null;
	location: string | null;
	editable: boolean;
	type: string | null;
	description: string | null;
	people: string | null;
	time: {
		start: {
			raw: string;
			formatted: string;
		};
		end: {
			raw: string;
			formatted: string;
		};
	};
}

dataRouter.route("/schedule").get(authenticateCheck, async (request, response) => {
	if (!response.locals.authenticated || !response.locals.user.registered) {
		response.json(await getScheduleForUser({
			username: "",
			registered: false
		}));
	}
	else {
		response.json(await getScheduleForUser({
			username: response.locals.user.username,
			registered: response.locals.user.registered
		}));
	}
});

export async function getScheduleForUser(user: { username: string; registered: boolean; }): Promise<ScheduleItem[]> {
	const dbSession = common.driver.session();
	try {
		if (!user.registered) {
			// Generalized schedule for unknown or unregistered users
			let results = await dbSession.run(`
				MATCH (item:ScheduleItem)
				RETURN
					item.title AS title,
					item.start AS start,
					item.end AS end,
					item.location AS location,
					item.editable AS editable
				ORDER BY item.start
			`);
			return results.records.map(record => {
				return {
					title: record.get("title"),
					slug: null,
					location: record.get("location") || null,
					editable: record.get("editable") || false,
					type: null,
					description: null,
					people: null,
					time: {
						"start": {
							"raw": record.get("start"),
							"formatted": moment(record.get("start")).format(timeFormat)
						},
						"end": {
							"raw": record.get("end"),
							"formatted": moment(record.get("end")).format(timeFormat)
						}
					}
				};
			});
		}
		else {
			let sessions = (await dbSession.run(`
				MATCH (user:User {username: {username}})-[r:ATTENDS]->(s:Session)
				RETURN
					s.title AS title,
					s.slug AS slug,
					s.startTime AS start,
					s.endTime AS end,
					s.location AS location,
					s.type AS type,
					s.description AS description,
					true AS editable
			`, { username: user.username })).records;

			let presenterNames: {
				[slug: string]: string[]
			} = {};
			for (let session of sessions) {
				let presenters = await dbSession.run(`
					MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: {slug}})
					RETURN user.name AS name
				`, { slug: session.get("slug") });
				presenterNames[session.get("slug")] = presenters.records.map(record => record.get("name"));
			}

			let items = (await dbSession.run(`
				MATCH (item:ScheduleItem)
				RETURN item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable
				ORDER BY item.start
			`)).records;

			let scheduleItems: ScheduleItem[] = [];
			for (let i = 0; i < items.length; i++) {
				let scheduleItem: ScheduleItem = {
					title: items[i].get("title"),
					slug: null,
					location: items[i].get("location") || null,
					editable: items[i].get("editable") || false,
					type: null,
					description: null,
					people: null,
					time: {
						"start": {
							"raw": items[i].get("start"),
							"formatted": moment(items[i].get("start")).format(timeFormat)
						},
						"end": {
							"raw": items[i].get("end"),
							"formatted": moment(items[i].get("end")).format(timeFormat)
						}
					}
				};
				// Insert registration choices into schedule at editable periods
				if (items[i].get("editable")) {
					let set: boolean = false;
					for (let j = 0; j < sessions.length; j++) {
						if (moment(sessions[j].get("start")).isSame(moment(items[i].get("start")))) {
							//items[i] = sessions[j];
							scheduleItem.title = sessions[j].get("title");
							scheduleItem.slug = sessions[j].get("slug");
							scheduleItem.location = sessions[j].get("location") || null;
							scheduleItem.editable = true;
							scheduleItem.type = sessions[j].get("type");
							scheduleItem.description = sessions[j].get("description") || null;

							set = true;
							let people = presenterNames[sessions[j].get("slug")];
							// Sort people by last name
							people = people.sort(function (a, b) {
								let aSplit = a.toLowerCase().split(" ");
								let bSplit = b.toLowerCase().split(" ");
								// Extract last names
								a = aSplit[aSplit.length - 1];
								b = bSplit[bSplit.length - 1];
								// Sort based on last name
								if (a < b) return -1;
								if (a > b) return 1;
								return 0;
							});
							scheduleItem.people = people.join(", ");
							// Return type of form "Global" or "Science" instead of including "session" at the end
							if (scheduleItem.type) {
								scheduleItem.type = scheduleItem.type.split(" ")[0];
							}
							break;
						}
					}
					if (!set) {
						// Couldn't find registered session for this editable time so it must be a free
						scheduleItem.title = "Free";
					}
				}
				scheduleItems.push(scheduleItem);
			}
			return scheduleItems;
		}
	}
	finally {
		dbSession.close();
	}
}
dataRouter.route("/sessions").get(async (request, response) => {
	try {
		const dbSession = common.driver.session();

		let results = await dbSession.run(`
			MATCH (s:Session)
			RETURN
				s.title AS title,
				s.slug AS slug,
				s.description AS description,
				s.type AS type,
				s.location AS location,
				s.capacity AS capacity,
				s.attendees AS attendees,
				s.startTime AS startTime,
				s.endTime AS endTime
			ORDER BY s.startTime, lower(s.title)
		`);
		let sessions = await Promise.all(results.records.map(async session => {
			let presenters = await dbSession.run(`
				MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: { slug }})
				RETURN user.username AS username, user.name AS name
				ORDER BY last(split(user.name, \" \"))
			`, { slug: session.get("slug") });
			let moderator = await dbSession.run(`
				MATCH (user:User)-[r:MODERATES]->(s:Session {slug: { slug }})
				RETURN user.username AS username, user.name AS name
			`, { slug: session.get("slug") });
			return {
				"title": {
					"formatted": session.get("title"),
					"slug": session.get("slug")
				},
				"description": session.get("description"),
				"type": session.get("type"),
				"location": session.get("location"),
				"capacity": {
					"total": session.get("capacity"),
					"filled": session.get("attendees")
				},
				"time": {
					"start": {
						"raw": session.get("startTime"),
						"formatted": moment(session.get("startTime")).format(timeFormat)
					},
					"end": {
						"raw": session.get("endTime"),
						"formatted": moment(session.get("endTime")).format(timeFormat)
					},
					"date": moment(session.get("startTime")).format(dateFormat)
				},
				"presenters": presenters.records.map(record => record.toObject()),
				"moderator": (moderator.records.length !== 0) ? moderator.records[0].toObject() : null
			};
		}));
		dbSession.close();
		response.json(sessions);
	}
	catch (err) {
		common.handleError(response, err);
	}
});
dataRouter.route("/date").get(async (request, response) => {
	try {
		response.json({
			"formatted": (await common.getSymposiumDate()).format(dateFormat)
		});
	}
	catch (err) {
		common.handleError(response, err);
	}
});
