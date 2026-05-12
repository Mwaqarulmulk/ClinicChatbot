import "../src/config";
import { bootstrapDatabase } from "../src/db/bootstrap";
import { initKnowledgeBase, upsertKnowledge } from "../src/rag/knowledge-base";
import { config } from "../src/config";

await bootstrapDatabase();
await initKnowledgeBase();

const examples = [
  {
    title: "Business Hours",
    content:
      "Demo Clinic is open Monday to Saturday from 9:00 AM to 6:00 PM. On Sundays we are available only by special request — please contact us in advance to arrange a Sunday appointment. We recommend booking ahead to avoid long wait times, especially on weekdays.",
  },
  {
    title: "Services Offered",
    content:
      "We offer a wide range of medical services including General Consultation, Dental Care, Pediatrics, Gynecology & Obstetrics, Dermatology, ENT (Ear Nose Throat), Eye Care, Lab Tests, X-Ray & Imaging, and Minor Surgeries. Whether it's a routine checkup or a specialist visit, Demo Clinic has you covered under one roof.",
  },
  {
    title: "Consultation Fees",
    content:
      "General consultation is Rs. 1,500 and specialist consultations are Rs. 2,500. Dental consultations are Rs. 2,000. If you return within 7 days of your last visit, a discounted follow-up fee of Rs. 800 applies. Lab tests range from Rs. 500 to Rs. 5,000 depending on the test required.",
  },
  {
    title: "Doctors at the Clinic",
    content:
      "Our team of qualified doctors includes Dr. Ahmed Khan (MBBS) for General Medicine, Dr. Fatima Ali (BDS) for Dental Care, Dr. Sara Malik (MBBS, FCPS) for Gynecology & Obstetrics, Dr. Bilal Hassan (MBBS, DCH) for Pediatrics, and Dr. Usman Raza (MBBS, DDVL) for Dermatology. All doctors are experienced, registered professionals committed to your wellbeing.",
  },
  {
    title: "Appointment Booking",
    content:
      "You can easily book an appointment through WhatsApp — just message us and we will find a suitable slot for you. Appointments are in 30-minute slots. Please arrive at least 10 minutes before your scheduled time. If you need to cancel, kindly inform us at least 2 hours in advance so we can offer the slot to another patient.",
  },
  {
    title: "Emergency Contact",
    content:
      "Demo Clinic does not handle life-threatening emergencies. In case of a serious emergency such as a heart attack, stroke, or severe injury, please call 1122 immediately or go to the nearest hospital emergency room. For urgent but non-emergency medical concerns during clinic hours, feel free to contact us and we will do our best to accommodate you quickly.",
  },
  {
    title: "Location and Directions",
    content:
      "Demo Clinic is located at 123 Main Boulevard, Gulberg III, Lahore. We are near the XYZ Landmark, making us easy to find. Ample parking is available on-site for patients and visitors. If you need directions, feel free to ask and we will guide you.",
  },
  {
    title: "Payment Methods",
    content:
      "We currently accept cash, EasyPaisa, JazzCash, and direct bank transfer. We do not yet accept credit or debit cards, so please plan accordingly. For insurance patients, we accept Adamjee Insurance, EFU Health, and Jubilee Life Insurance — bring your insurance card at the time of visit.",
  },
  {
    title: "Lab Services",
    content:
      "Our in-house laboratory offers a full range of tests including CBC (Complete Blood Count), Blood Sugar (Fasting and Random), Urine DR, Liver Function Tests, Kidney Function Tests, Thyroid Profile, Pregnancy Test, and HbA1c. Most reports are ready within 2 to 4 hours. Lab reports can be collected from reception or sent to you via WhatsApp.",
  },
  {
    title: "Pharmacy",
    content:
      "Demo Clinic has an attached pharmacy open from 9:00 AM to 8:00 PM, including Sundays. Patients presenting a valid prescription from a Demo Clinic doctor receive a special discount on their medicines. The pharmacy stocks a wide range of medicines and can also guide you on over-the-counter products.",
  },
  {
    title: "Dental Services",
    content:
      "Our dental department offers teeth cleaning and scaling, fillings, tooth extractions, root canal treatment, braces consultation, and dental X-rays. Dr. Fatima Ali handles all dental cases and is available during regular clinic hours. Emergency dental services for pain relief and extractions are available on weekdays — please call ahead to confirm availability.",
  },
  {
    title: "Pediatric Services",
    content:
      "Dr. Bilal Hassan (MBBS, DCH) provides comprehensive pediatric care including well-baby checkups, vaccination schedules, growth and development monitoring, and treatment for common childhood illnesses like fever, colds, and infections. We create a friendly and comfortable environment for children and parents alike.",
  },
  {
    title: "Gynecology and Obstetrics",
    content:
      "Dr. Sara Malik (MBBS, FCPS) specializes in women's health including antenatal care, obstetric ultrasound, family planning counseling, PCOS management, and infertility consultations. All consultations are conducted with full privacy and sensitivity. We encourage women to schedule regular checkups for preventive health.",
  },
  {
    title: "Wait Times",
    content:
      "The average waiting time at Demo Clinic is 15 to 30 minutes. Booking an appointment in advance significantly reduces your wait time. Walk-in patients are also welcome whenever slots are available, but appointment holders are given priority. We appreciate your patience and try our best to see everyone promptly.",
  },
  {
    title: "What to Bring",
    content:
      "When visiting Demo Clinic, please bring your CNIC (National Identity Card), any previous prescriptions or medical records related to your condition, recent lab or test reports if available, and your insurance card if you are covered under an insurance plan. Having these ready helps the doctor provide better and faster care.",
  },
  {
    title: "Follow-up Policy",
    content:
      "If you return to the clinic within 7 days of your original consultation for the same issue, you qualify for a discounted follow-up fee of Rs. 800 — roughly half the regular consultation fee. After 7 days, the full consultation fee will apply. Please mention that you are coming for a follow-up when booking so we can schedule you accordingly.",
  },
  {
    title: "COVID and Infection Control",
    content:
      "The safety of our patients and staff is a top priority. We strongly recommend wearing a mask inside the clinic. Hand sanitizers are available at the entrance and throughout the facility. If you are experiencing fever, cough, or cold symptoms, please reschedule your appointment to protect other patients and our medical team.",
  },
  {
    title: "Online Lab Reports via WhatsApp",
    content:
      "Lab reports are typically ready within 2 to 4 hours of sample collection. Once ready, your report will be sent directly to your WhatsApp number on file. If you prefer, you can also collect a printed copy from the reception desk. For any queries about your report, please don't hesitate to ask.",
  },
  {
    title: "Prescription Refills",
    content:
      "For routine prescription refills, you can message us on WhatsApp with your previous prescription and we will try to assist you. However, a doctor review is mandatory for controlled medications and long-term prescriptions. Please bring your old prescription when visiting for a refill to make the process quick and smooth.",
  },
  {
    title: "Clinic Facilities",
    content:
      "Demo Clinic offers a clean, comfortable, and modern environment. The waiting area is fully air-conditioned. We have a dedicated prayer area, a baby changing room, clean washrooms, and the clinic is wheelchair accessible for patients with mobility needs. Free WiFi is available in the waiting area for patients.",
  },
  {
    title: "Feedback and Complaints",
    content:
      "We value your feedback and are always looking to improve our services. You can share your feedback, suggestions, or complaints directly via WhatsApp or by speaking to our reception staff. Patient satisfaction is our highest priority and we take all feedback seriously to make your experience better.",
  },
  {
    title: "Special Health Packages",
    content:
      "Demo Clinic offers a Full Health Checkup Package for Rs. 5,000 which includes CBC, blood sugar test, urine test, liver function, kidney function, ECG, and a doctor's consultation — great value for a comprehensive health snapshot. We also offer a Prenatal Care Package for expectant mothers. Ask our reception for details on available packages and pricing.",
  },
];

for (const item of examples) {
  const chunks = await upsertKnowledge({
    businessId: config.DEFAULT_BUSINESS_ID,
    title: item.title,
    content: item.content,
    source: "seed",
  });
  console.log(`Seeded ${item.title}: ${chunks} chunk(s)`);
}
